// 批次运行器
// 固定筛选范围 + 站点数据版本快照 -> 滚动采集列表 -> 逐单进入明细 -> 校验 -> 截图 -> 返回列表续采。
// 登录过期：立即暂停并落盘进度；下次运行用页面登录表单重新登录，只补未完成订单。
import type { Browser, Page } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso, type BatchProgress, type BatchRow } from '../server/db.js'
import { launchBrowser } from './browser.js'
import {
  S,
  applyDateFilter,
  assertFixedSort,
  detectAuthState,
  openOrderDetail,
  readDetail,
  readListState,
  readRestoredScrollTop,
  scrollListTo,
  waitForDetailReady,
  type ListRow,
} from './dom.js'
import { collectList, type BatchSnapshot } from './list.js'
import { DEMO_CREDENTIALS, LoginExpiredError, loginFromCurrentPage, type Credentials } from './session.js'
import { validateDetail, type ScrapedDetail } from '../shared/validate.js'
import { compareOrders } from '../shared/orderSort.js'
import { LIST_ROW_HEIGHT } from '../shared/contract.js'

export interface RunnerConfig {
  db: DatabaseSync
  siteUrl: string
  screenshotDir: string
  credentials?: Credentials
}

export interface RunOutcome {
  status: 'completed' | 'incomplete' | 'paused' | 'error'
  reason: string | null
  collected: number
  detailDone: number
  exceptions: number
  screenshots: number
}

interface OrderWorkItem {
  id: number
  orderNo: string
}

export class BatchRunner {
  private progress: BatchProgress

  constructor(
    private readonly cfg: RunnerConfig,
    private readonly batch: BatchRow,
  ) {
    this.progress = {
      ...parseProgressSafe(batch.progressJson),
      // 进度里固定记录本批的筛选与排序口径，作为断点恢复的依据
      filterFrom: batch.filterFrom,
      filterTo: batch.filterTo,
      sortField: batch.sortField,
      sortDirection: batch.sortDirection,
    }
  }

  private get db(): DatabaseSync {
    return this.cfg.db
  }

  async run(): Promise<RunOutcome> {
    const runId = this.startRun()
    let browser: Browser | null = null
    let screenshots = 0
    const apiAttempts: string[] = []

    try {
      const launched = await launchBrowser()
      browser = launched.browser
      const page = await launched.context.newPage()
      // 网络守卫：采集端只读页面可见内容；页面若尝试访问 /api 一律拦截并记账。
      await page.route('**/api/**', (route) => {
        apiAttempts.push(route.request().url())
        return route.abort()
      })

      const credentials = this.cfg.credentials ?? DEMO_CREDENTIALS
      const listPath = this.listPath()

      // ---- 0. 登录并进入筛选后的列表 ----
      await this.openFilteredList(page, credentials, listPath)

      const snapshot: BatchSnapshot = {
        dataVersion: this.batch.dataVersion,
        expectedCount: this.batch.expectedCount,
        snapshotMaxPlacedAtMs: this.batch.snapshotMaxPlacedAtMs,
      }

      // ---- 1. 列表：全量滚动采集 ----
      const knownFromDb = this.existingOrderSet()
      const listAlreadyComplete =
        this.progress.phase !== 'list' && knownFromDb.size === this.batch.expectedCount && this.batch.expectedCount > 0

      if (!listAlreadyComplete) {
        this.setStatus('listing')
        const listResult = await collectList(page, snapshot, {
          credentials,
          reloginPath: listPath,
          resumeFromScrollTop: this.progress.phase === 'list' ? this.progress.scrollTop : 0,
          alreadyCollected: knownFromDb,
          onScreen: async (p) => {
            // 每屏都把新读到的行落到数据库，进程中断后可以从这里继续；
            // 落库时记录该行「第一次被看到时的滚动位置」，续采时直接滚回这一屏
            if (p.newRows.length > 0) this.persistListRows(p.newRows, p.scrollTopFor)
            this.progress = {
              ...this.progress,
              scrollTop: p.scrollTop,
              phase: 'list',
              currentOrderNo: null,
              listIndex: 0,
              savedAt: nowIso(),
            }
            await this.saveProgress()
            this.updateRunProgress(runId, this.countOrders())
          },
        })

        if (!listResult.reachedEnd || listResult.collectedCount !== this.batch.expectedCount) {
          const reason = !listResult.reachedEnd
            ? `页面未提示到底：已收集 ${listResult.collectedCount}/${this.batch.expectedCount}`
            : `已收集 ${listResult.collectedCount} 笔，与筛选总数 ${this.batch.expectedCount} 不一致`
          this.setStatus('incomplete')
          this.finishRun(runId, 'incomplete', reason, screenshots)
          return this.outcome('incomplete', reason, screenshots)
        }
        this.persistListRows([...listResult.rows.values()].filter((r): r is ListRow => Boolean(r && r.placedAt)), listResult.scrollTopFor)
        if (listResult.dataVersionChanged) {
          this.recordException(
            null,
            'DATA_VERSION_CHANGED',
            'warning',
            `本批固定数据版本 ${this.batch.dataVersion}，采集时页面为 ${listResult.dataVersion}；快照后新建的订单已排除`,
          )
        }
        if (listResult.excludedNewOrders.length > 0) {
          this.recordException(null, 'NEW_ORDERS_EXCLUDED', 'warning', `批次快照后新建 ${listResult.excludedNewOrders.length} 笔订单，未纳入本批`)
        }
        if (this.countOrders() !== this.batch.expectedCount) {
          const reason = `已落库 ${this.countOrders()} 笔，与筛选总数 ${this.batch.expectedCount} 不一致`
          this.setStatus('incomplete')
          this.finishRun(runId, 'incomplete', reason, screenshots)
          return this.outcome('incomplete', reason, screenshots)
        }
      }

      // ---- 2. 明细：逐单进入、等待加载、核对、截图、返回列表续采 ----
      this.setStatus('detail')
      const items = this.pendingDetailOrders()
      for (const item of items) {
        let pos: { index: number; listScrollTop: number }
        try {
          pos = await this.locateOrder(page, item)
        } catch (e) {
          if (e instanceof LoginExpiredError) {
            await this.pauseOnExpiry(runId, item.orderNo)
            return this.outcome('paused', '登录已过期，采集已暂停；重新登录后再次运行只补未完成订单', screenshots)
          }
          throw e
        }
        this.progress = {
          ...this.progress,
          scrollTop: pos.listScrollTop,
          listIndex: pos.index,
          phase: 'detail',
          currentOrderNo: item.orderNo,
          savedAt: nowIso(),
        }
        await this.saveProgress()

        let done = false
        let lastError: Error | null = null
        let clickedAtScrollTop = pos.listScrollTop
        for (let attempt = 1; attempt <= 2 && !done; attempt++) {
          try {
            // 进入明细前，确保列表停在保存的滚动位置
            await scrollListTo(page, pos.listScrollTop)
            const nav = await openOrderDetail(page, item.orderNo, pos.index, pos.listScrollTop)
            clickedAtScrollTop = nav.scrollTopAtClick
            await this.ensureAuthenticated(page)
            await waitForDetailReady(page)
            const scraped = await readDetail(page, item.orderNo)
            const expected = this.expectedFromList(item.id)
            const validation = validateDetail(scraped, expected)
            screenshots += await this.saveScreenshot(page, item.orderNo)
            this.persistDetail(item.id, scraped, validation)
            done = true
          } catch (e) {
            if (e instanceof LoginExpiredError) {
              // 登录过期：暂停。下次运行只补没完成的订单。
              await this.pauseOnExpiry(runId, item.orderNo)
              return this.outcome('paused', '登录已过期，采集已暂停；重新登录后再次运行只补未完成订单', screenshots)
            }
            lastError = e as Error
            await this.captureFailureScreenshot(page, item.orderNo).catch(() => null)
            screenshots += 1
            await this.returnToList(page, listPath).catch(() => undefined)
          }
        }
        if (!done) {
          this.recordOrderFailure(item.id, lastError?.message ?? '明细采集失败')
          this.recordException(item.orderNo, 'DETAIL_FAILED', 'error', `明细采集失败：${lastError?.message ?? ''}`, null)
        } else {
          // 返回列表：页面会从进入明细前的滚动位置恢复，采集端核对该恢复值后继续。
          try {
            await this.returnToList(page, listPath)
          } catch (e) {
            if (e instanceof LoginExpiredError) {
              // 明细已核对并落库，只是返回列表时会话过期：暂停，下次从这张订单之后继续
              this.persistCompletedBeforePause(item, pos, clickedAtScrollTop)
              await this.pauseOnExpiry(runId, item.orderNo)
              return this.outcome('paused', '登录已过期，采集已暂停；重新登录后再次运行只补未完成订单', screenshots)
            }
            throw e
          }
          const expectedPos = await this.clampScrollTop(page, clickedAtScrollTop)
          const restored = await readRestoredScrollTop(page)
          if (Math.abs(restored - expectedPos) > 2) {
            this.recordException(
              item.orderNo,
              'SCROLL_RESTORE_MISMATCH',
              'warning',
              `返回列表后页面恢复的滚动位置为 ${restored}px，进入明细前为 ${expectedPos}px`,
              null,
            )
            await scrollListTo(page, expectedPos)
          }
          // 从恢复后的位置继续采集
          this.progress = { ...this.progress, scrollTop: expectedPos, listIndex: pos.index, savedAt: nowIso() }
          await this.saveProgress()
        }
        this.updateRunProgress(runId, this.countOrders())
      }

      // ---- 3. 收尾判断 ----
      const collected = this.countOrders()
      const detailDone = this.countDetailDone()
      const failed = this.countFailed()
      if (collected === this.batch.expectedCount && detailDone === this.batch.expectedCount && failed === 0) {
        this.progress = { ...this.progress, phase: 'done', currentOrderNo: null, savedAt: nowIso() }
        this.saveProgress()
        this.setStatus('completed')
        this.finishRun(runId, 'completed', null, screenshots)
        return this.outcome('completed', null, screenshots)
      }
      const reason = `明细已核对 ${detailDone}/${this.batch.expectedCount}，失败 ${failed}`
      this.setStatus('incomplete')
      this.finishRun(runId, 'incomplete', reason, screenshots)
      return this.outcome('incomplete', reason, screenshots)
    } catch (e) {
      const err = e as Error
      if (err instanceof LoginExpiredError) {
        await this.pauseOnExpiry(runId, this.progress.currentOrderNo)
        this.finishRun(runId, 'paused', err.message, screenshots)
        return this.outcome('paused', err.message, screenshots)
      }
      this.setStatus('error')
      this.recordException(null, 'RUN_ERROR', 'error', err.message)
      this.finishRun(runId, 'error', err.message, screenshots)
      return this.outcome('error', err.message, screenshots)
    } finally {
      if (apiAttempts.length > 0) {
        this.recordException(null, 'API_ACCESS_BLOCKED', 'warning', `页面尝试访问 ${apiAttempts.length} 次内部接口，已被阻止；采集仅使用可见内容`)
      }
      if (browser) await browser.close().catch(() => undefined)
    }
  }

  // ---------------- 页面导航 ----------------

  /** 打开筛选后的列表；遇到登录页/过期页就用页面表单登录。 */
  private async openFilteredList(page: Page, credentials: Credentials, listPath: string): Promise<void> {
    await page.goto(`${this.cfg.siteUrl}${listPath}`, { waitUntil: 'domcontentloaded' })
    let auth = await detectAuthState(page)
    if (auth !== 'ok') {
      const r = await loginFromCurrentPage(page, credentials)
      if (!r.ok) throw new LoginExpiredError(r.error ?? '无法登录演示站点')
      await page.goto(`${this.cfg.siteUrl}${listPath}`, { waitUntil: 'domcontentloaded' })
      auth = await detectAuthState(page)
      if (auth !== 'ok') throw new LoginExpiredError('登录后仍无法进入订单列表')
    }
    // 首次运行需要在页面上真实提交一次筛选（填写日期并点「筛选」），
    // 让列表页会话记住筛选条件；续采时 URL 已带同样参数，跳过重复操作。
    if (this.progress.phase === 'init' || this.batch.status === 'draft') {
      await this.safeApplyFilter(page)
    }
    await assertFixedSort(page)
    const totalNow = await this.pageTotal(page)
    if (totalNow !== null && totalNow < this.batch.expectedCount) {
      throw new Error(`页面上筛选范围内只有 ${totalNow} 笔订单，少于本批固定的 ${this.batch.expectedCount} 笔；站点数据可能已变化`)
    }
    // 批次固定站点数据版本：页面版本不同说明站点数据已变化（例如期间新建了订单）。
    // 已完成的采集不再重跑；未完成时明确记账，提示结果可能与本批快照不一致。
    const pageVersion = (await readListState(page)).dataVersion
    if (this.batch.dataVersion && pageVersion && pageVersion !== this.batch.dataVersion) {
      this.recordException(
        null,
        'DATA_VERSION_DRIFT',
        'warning',
        `页面数据版本为 ${pageVersion}，本批固定为 ${this.batch.dataVersion}`,
      )
    }
  }

  private async safeApplyFilter(page: Page): Promise<void> {
    const st = await readListState(page).catch(() => null)
    if (!st) return
    await applyDateFilter(page, this.batch.filterFrom, this.batch.filterTo).catch(async () => {
      // 筛选参数为空时页面 URL 不变，fill/click 后可能不触发导航；重新打开列表确认状态
      await page.goto(`${this.cfg.siteUrl}${this.listPath()}`, { waitUntil: 'domcontentloaded' })
    })
  }

  private async pageTotal(page: Page): Promise<number | null> {
    return (await readListState(page)).totalCount
  }

  /** 明细页若变成登录/过期页，说明会话失效：交给本轮暂停，下次运行重新登录后补采。 */
  private async ensureAuthenticated(page: Page): Promise<void> {
    if ((await detectAuthState(page)) !== 'ok') throw new LoginExpiredError('打开明细时会话已失效，采集已暂停')
  }

  private async returnToList(page: Page, listPath: string): Promise<void> {
    const auth = await detectAuthState(page)
    if (auth !== 'ok') throw new LoginExpiredError('返回列表时登录已过期')
    if (page.url().includes('/site/orders/')) {
      try {
        await Promise.all([
          page.waitForURL((u) => u.pathname === '/site/orders', { timeout: 15_000 }),
          page.locator(S.backToList).first().click(),
        ])
      } catch {
        await page.goto(`${this.cfg.siteUrl}${listPath}`, { waitUntil: 'domcontentloaded' })
      }
    }
    // 返回列表的请求可能正好撞上会话过期：先等页面渲染出列表或登录/过期提示，再判断。
    await page
      .waitForFunction(
        () => {
          const root = document.querySelector('#order-scroll')
          if (root) return true
          return document.querySelector('#expired-card') !== null || document.querySelector('#login-form') !== null
        },
        undefined,
        { timeout: 15_000 },
      )
      .catch(() => null)
    const after = await detectAuthState(page)
    if (after !== 'ok') throw new LoginExpiredError('登录已过期，返回列表失败，采集已暂停')
    await page.waitForSelector(S.scroll, { timeout: 15_000 })
    await assertFixedSort(page)
  }

  // ---------------- 列表定位 ----------------

  /**
   * 计算订单在页面上的位置：按固定排序键（下单时间倒序、订单号倒序）在快照内排序，
   * 再顺延页面顶部「快照之后新建」的订单数，得到页面索引与滚动位置。
   */
  private async locateOrder(page: Page, item: OrderWorkItem): Promise<{ index: number; listScrollTop: number }> {
    const keys = this.snapshotSortKeys()
    const idx = keys.findIndex((r) => r.orderNo === item.orderNo)
    let newer = 0
    try {
      newer = await this.countNewerPageRows(page)
    } catch (e) {
      if (e instanceof LoginExpiredError) throw e
      // 滚动定位失败时退回按已采集行记录的位置；openOrderDetail 仍会确认目标行可见后才点击
      newer = 0
    }
    const index = Math.max(0, idx) + newer
    const rowHeight = (await readListState(page)).rowHeight || LIST_ROW_HEIGHT
    const maxScroll = await this.maxScroll(page)
    // 优先使用列表采集时记录的「该订单首次出现时的滚动位置」，找不到再按索引换算
    const stored = this.db.prepare('SELECT list_scroll_top FROM orders WHERE id = ?').get(item.id) as
      | { list_scroll_top: number | null }
      | undefined
    const preferred = stored?.list_scroll_top ?? null
    const fromIndex = index * rowHeight
    const target = preferred !== null && preferred > 0 ? Math.max(preferred, fromIndex) : fromIndex
    return { index, listScrollTop: Math.min(maxScroll, Math.max(0, target)) }
  }

  private async maxScroll(page: Page): Promise<number> {
    const st = await readListState(page)
    return Math.max(0, st.scrollHeight - st.clientHeight)
  }

  private async clampScrollTop(page: Page, y: number): Promise<number> {
    return Math.min(await this.maxScroll(page), Math.max(0, y))
  }

  /** 页面顶部的快照之后新建订单数：二分查找第一条属于本批快照的行。 */
  private async countNewerPageRows(page: Page): Promise<number> {
    const st = await readListState(page)
    const total = st.totalCount ?? 0
    if (total === 0) return 0
    const rowHeight = st.rowHeight || 56
    const viewport = st.clientHeight || 560
    const readRowAt = async (index: number): Promise<number | null> => {
      const y = Math.max(0, Math.min(index * rowHeight - viewport / 2, st.scrollHeight - viewport))
      await scrollListTo(page, y)
      const snap = await readListState(page)
      for (const row of snap.rows) if (row.index === index) return row.placedAtMs
      // 目标索引不在视口内时，放宽到首个索引 >= index 的行
      const near = snap.rows.filter((r) => r.index >= index).sort((a, b) => a.index - b.index)[0]
      return near ? near.placedAtMs : null
    }
    let lo = 0
    let hi = total
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      const placedAtMs = await readRowAt(mid)
      if (placedAtMs === null) break
      if (placedAtMs > this.batch.snapshotMaxPlacedAtMs) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  // ---------------- 数据库 ----------------

  private listPath(): string {
    const p = new URLSearchParams()
    if (this.batch.filterFrom) p.set('from', this.batch.filterFrom)
    if (this.batch.filterTo) p.set('to', this.batch.filterTo)
    const qs = p.toString()
    return `/site/orders${qs ? `?${qs}` : ''}`
  }

  private existingOrderSet(): Set<string> {
    const rows = this.db.prepare('SELECT order_no FROM orders WHERE batch_id = ?').all(this.batch.id) as { order_no: string }[]
    return new Set(rows.map((r) => r.order_no))
  }

  private snapshotSortKeys(): { orderNo: string; placedAtMs: number }[] {
    const rows = this.db
      .prepare('SELECT order_no, placed_at_ms FROM orders WHERE batch_id = ?')
      .all(this.batch.id) as { order_no: string; placed_at_ms: number }[]
    return rows.map((r) => ({ orderNo: r.order_no, placedAtMs: Number(r.placed_at_ms) })).sort(compareOrders)
  }

  private persistListRows(rows: ListRow[], scrollTopFor?: Map<string, number>): void {
    const now = nowIso()
    const upsert = this.db.prepare(
      `INSERT INTO orders (batch_id, order_no, placed_at, placed_at_ms, buyer, status, total_text, item_count_text, list_scroll_top, phase, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
       ON CONFLICT(batch_id, order_no) DO UPDATE SET
         placed_at = excluded.placed_at, placed_at_ms = excluded.placed_at_ms,
         buyer = excluded.buyer, status = excluded.status, total_text = excluded.total_text,
         item_count_text = excluded.item_count_text, list_scroll_top = excluded.list_scroll_top,
         updated_at = excluded.updated_at
       WHERE orders.phase IN ('pending') OR orders.phase IS NULL`,
    )
    for (const row of rows) {
      if (!row.orderNo || !row.placedAt) continue
      upsert.run(
        this.batch.id,
        row.orderNo,
        row.placedAt,
        row.placedAtMs,
        row.buyer,
        row.status,
        row.totalText,
        row.itemCountText,
        Math.max(0, Math.floor(scrollTopFor?.get(row.orderNo) ?? Number(row.index || 0) * LIST_ROW_HEIGHT)),
        now,
        now,
      )
    }
  }

  private expectedFromList(orderId: number) {
    const r = this.db
      .prepare('SELECT order_no, buyer, placed_at, total_text, item_count_text FROM orders WHERE id = ?')
      .get(orderId) as { order_no: string; buyer: string; placed_at: string; total_text: string; item_count_text: string }
    return { orderNo: r.order_no, buyer: r.buyer, placedAt: r.placed_at, totalText: r.total_text, itemCountText: r.item_count_text }
  }

  private persistDetail(orderId: number, scraped: ScrapedDetail, validation: ReturnType<typeof validateDetail>): void {
    const now = nowIso()
    this.db.prepare('DELETE FROM order_lines WHERE order_id = ?').run(orderId)
    const ins = this.db.prepare(
      'INSERT INTO order_lines (order_id, line_no, sku, name, unit_price_cents, quantity, amount_cents, line_sum_ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const line of scraped.lines) {
      const unit = Number(line.unitPriceText.replace(/[¥￥,]/g, '')) * 100
      const qty = Number(line.quantityText.replace(/[^\d]/g, '')) || 0
      const amount = Number(line.amountText.replace(/[¥￥,]/g, '')) * 100
      const ok = Math.round(unit) * qty === Math.round(amount) ? 1 : 0
      ins.run(orderId, line.lineNo, line.sku, line.name, Math.round(unit), qty, Math.round(amount), ok)
    }
    const errors = validation.issues.filter((i) => i.severity === 'error')
    const phase = validation.orderNoOk && validation.itemCountOk && validation.totalOk && errors.length === 0 ? 'verified' : 'failed'
    this.db
      .prepare(
        'UPDATE orders SET phase = ?, attempt_count = attempt_count + 1, last_error = ?, issues_json = ?, detailed_at = ?, updated_at = ? WHERE id = ?',
      )
      .run(phase, errors.length ? errors.map((i) => i.message).join('；') : null, JSON.stringify(validation), now, now, orderId)
    for (const issue of validation.issues) {
      this.recordException(scraped.orderNo, issue.code, issue.severity, issue.message, null)
    }
  }

  private recordOrderFailure(orderId: number, message: string, screenshotPath: string | null = null): void {
    const now = nowIso()
    this.db
      .prepare('UPDATE orders SET attempt_count = attempt_count + 1, last_error = ?, phase = ?, updated_at = ? WHERE id = ?')
      .run(message, 'pending', now, orderId)
    if (screenshotPath) this.db.prepare('UPDATE orders SET screenshot_path = ? WHERE id = ?').run(screenshotPath, orderId)
  }

  recordException(orderNo: string | null, code: string, severity: 'error' | 'warning', message: string, screenshotPath: string | null = null): void {
    this.db
      .prepare('INSERT INTO exceptions (batch_id, order_no, code, severity, message, created_at, screenshot_path) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(this.batch.id, orderNo, code, severity, message, nowIso(), screenshotPath)
  }

  private async captureFailureScreenshot(page: Page, orderNo: string): Promise<string | null> {
    const dir = resolve(this.cfg.screenshotDir, this.batch.id)
    try {
      await mkdir(dir, { recursive: true })
      await page.screenshot({ path: resolve(dir, `${orderNo}-failed.png`), fullPage: false })
      const rel = `${this.batch.id}/${orderNo}-failed.png`
      this.db.prepare('UPDATE orders SET screenshot_path = ? WHERE batch_id = ? AND order_no = ?').run(rel, this.batch.id, orderNo)
      return rel
    } catch {
      return null
    }
  }

  private async saveScreenshot(page: Page, orderNo: string): Promise<number> {
    const dir = resolve(this.cfg.screenshotDir, this.batch.id)
    await mkdir(dir, { recursive: true })
    const abs = resolve(dir, `${orderNo}.png`)
    try {
      await page.locator(S.detailCard).first().screenshot({ path: abs, type: 'png' })
    } catch {
      await page.screenshot({ path: abs, type: 'png', fullPage: false })
    }
    const rel = `${this.batch.id}/${orderNo}.png`
    this.db.prepare('UPDATE orders SET screenshot_path = ? WHERE batch_id = ? AND order_no = ?').run(rel, this.batch.id, orderNo)
    return 1
  }

  // ---------------- 登录过期 ----------------

  /** 明细已核对完、但返回列表时会话过期：把这张订单的进度保存好再暂停。 */
  private persistCompletedBeforePause(item: OrderWorkItem, pos: { index: number; listScrollTop: number }, clickedAtScrollTop: number): void {
    this.progress = { ...this.progress, scrollTop: clickedAtScrollTop, listIndex: pos.index, currentOrderNo: item.orderNo, savedAt: nowIso() }
    this.saveProgress()
  }

  private async pauseOnExpiry(runId: number, orderNo: string | null): Promise<void> {
    this.progress = { ...this.progress, phase: 'paused', currentOrderNo: orderNo, savedAt: nowIso() }
    this.saveProgress()
    this.setStatus('paused')
    this.recordException(orderNo, 'LOGIN_EXPIRED', 'warning', '登录已过期，采集已暂停；重新登录后再次运行只补未完成订单', null)
    this.db.prepare('INSERT INTO site_expiries (path, at) VALUES (?, ?)').run(orderNo ? `/site/orders/${orderNo}` : '/site/orders', nowIso())
    this.finishRun(runId, 'paused', '登录已过期', 0)
  }

  // ---------------- 状态 ----------------

  private pendingDetailOrders(): OrderWorkItem[] {
    const rows = this.db
      .prepare("SELECT id, order_no FROM orders WHERE batch_id = ? AND phase IN ('pending','failed','detail_done') ORDER BY placed_at_ms DESC, order_no DESC")
      .all(this.batch.id) as { id: number; order_no: string }[]
    return rows.map((r) => ({ id: Number(r.id), orderNo: r.order_no }))
  }

  countOrders(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM orders WHERE batch_id = ?').get(this.batch.id) as { n: number }).n)
  }
  countDetailDone(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE batch_id = ? AND phase = 'verified'").get(this.batch.id) as { n: number }).n)
  }
  countFailed(): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE batch_id = ? AND phase = 'failed'").get(this.batch.id) as { n: number }).n)
  }
  countExceptions(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM exceptions WHERE batch_id = ?').get(this.batch.id) as { n: number }).n)
  }

  private outcome(status: RunOutcome['status'], reason: string | null, screenshots: number): RunOutcome {
    return {
      status,
      reason,
      collected: this.countOrders(),
      detailDone: this.countDetailDone(),
      exceptions: this.countExceptions(),
      screenshots,
    }
  }

  private setStatus(status: string): void {
    this.db.prepare('UPDATE batches SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), this.batch.id)
  }

  private saveProgress(): void {
    this.db.prepare('UPDATE batches SET progress_json = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(this.progress), nowIso(), this.batch.id)
  }

  private startRun(): number {
    const info = this.db.prepare('INSERT INTO runs (batch_id, started_at, status) VALUES (?, ?, ?)').run(this.batch.id, nowIso(), 'running')
    const runId = Number(info.lastInsertRowid)
    this.db.prepare('UPDATE batches SET last_run_id = ?, updated_at = ? WHERE id = ?').run(runId, nowIso(), this.batch.id)
    return runId
  }

  private updateRunProgress(runId: number, collected: number): void {
    this.db
      .prepare('UPDATE runs SET collected_count = ?, detail_count = ?, exception_count = ? WHERE id = ?')
      .run(collected, this.countDetailDone(), this.countExceptions(), runId)
  }

  private finishRun(runId: number, status: string, reason: string | null, screenshots: number): void {
    this.db
      .prepare('UPDATE runs SET finished_at = ?, status = ?, reason = ?, collected_count = ?, detail_count = ?, exception_count = ?, screenshots = ? WHERE id = ?')
      .run(nowIso(), status, reason, this.countOrders(), this.countDetailDone(), this.countExceptions(), screenshots, runId)
  }
}

function parseProgressSafe(json: string | null): BatchProgress {
  if (json) {
    try {
      return { ...defaultProgress(), ...(JSON.parse(json) as Partial<BatchProgress>) }
    } catch {
      /* ignore */
    }
  }
  return defaultProgress()
}

function defaultProgress(): BatchProgress {
  return {
    scrollTop: 0,
    listIndex: 0,
    filterFrom: '',
    filterTo: '',
    sortField: 'placedAt',
    sortDirection: 'desc',
    collectedOrderNos: [],
    skippedNewerCount: 0,
    currentOrderNo: null,
    phase: 'init',
    savedAt: nowIso(),
  }
}
