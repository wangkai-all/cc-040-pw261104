// 采集端页面读取层：只从页面已经渲染出来的内容取值。
// 不调用 /api、不读 __SITE_BOOT__、不发额外请求取数据。
import type { Page } from 'playwright'
import { parseMoneyToCents, parseCount } from '../shared/money.js'
import type { ScrapedDetail } from '../shared/validate.js'
import { SITE_SORT_LABEL } from '../shared/contract.js'

export const S = {
  scroll: '#order-scroll',
  row: '[data-order-row]',
  link: 'a[data-order-link]',
  summary: '#list-summary',
  sortLabel: '[data-sort-label]',
  version: '[data-data-version]',
  reachedEnd: '[data-reached-end]',
  expired: '#expired-card',
  loginForm: '#login-form',
  username: '#username',
  password: '#password',
  loginSubmit: '#login-submit',
  loginError: '[data-login-error]',
  relogin: '#relogin-link',
  detailCard: '#detail-card',
  detailLines: '[data-detail-lines]',
  detailLine: '[data-detail-line]',
  detailNo: '[data-detail-order-no]',
  detailStatus: '[data-detail-status]',
  detailBuyer: '[data-detail-buyer]',
  detailPlacedAt: '[data-detail-placed-at]',
  detailCount: '[data-detail-count]',
  detailTotal: '[data-detail-total]',
  detailLoading: '#detail-loading',
  backToList: '#back-to-list',
} as const

export interface ListRow {
  orderNo: string
  placedAt: string
  placedAtMs: number
  buyer: string
  status: string
  itemCountText: string
  itemCount: number | null
  totalText: string
  totalCents: number | null
  /** 该行在固定排序中的序号（由页面虚拟列表给出） */
  index: number
}

export interface ListState {
  rows: ListRow[]
  totalCount: number | null
  sortLabel: string
  dataVersion: string
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  rowHeight: number
  reachedEnd: boolean
}

export async function isLoginExpired(page: Page): Promise<boolean> {
  return (await page.locator(S.expired).count()) > 0
}

export async function isLoginPage(page: Page): Promise<boolean> {
  return (await page.locator(S.loginForm).count()) > 0
}

export async function detectAuthState(page: Page): Promise<'ok' | 'expired' | 'login'> {
  if (await isLoginExpired(page)) return 'expired'
  if (await isLoginPage(page)) return 'login'
  return 'ok'
}

/** 读取列表当前状态。rows 仅包含真正落在滚动视口内的行。 */
export async function readListState(page: Page): Promise<ListState> {
  const data = await page.evaluate(() => {
    const scroll = document.querySelector('#order-scroll') as HTMLElement | null
    const summary = document.querySelector('#list-summary')
    const sortLabel = document.querySelector('[data-sort-label]')
    const version = document.querySelector('[data-data-version]')
    const vp = scroll?.getBoundingClientRect() ?? null
    const out: ListRow[] = []
    if (scroll && vp) {
      for (const el of Array.from(scroll.querySelectorAll('[data-order-row]'))) {
        const row = el as HTMLElement
        const rect = row.getBoundingClientRect()
        const visible = rect.height > 0 && rect.bottom > vp.top + 1 && rect.top < vp.bottom - 1
        if (!visible) continue
        out.push({
          orderNo: row.getAttribute('data-order-no') ?? '',
          placedAt: (row.querySelector('[data-placed-at]')?.textContent ?? '').trim(),
          placedAtMs: Number(row.getAttribute('data-placed-at-ms') ?? 'NaN'),
          buyer: (row.querySelector('[data-buyer]')?.textContent ?? '').trim(),
          status: (row.querySelector('[data-status]')?.textContent ?? '').trim(),
          itemCountText: (row.querySelector('[data-item-count]')?.textContent ?? '').trim(),
          itemCount: null,
          totalText: (row.querySelector('[data-total]')?.textContent ?? '').trim(),
          totalCents: null,
          index: Number(row.getAttribute('data-row-index') ?? 'NaN'),
        })
      }
    }
    return {
      rows: out,
      totalAttr: summary?.getAttribute('data-total-count') ?? '',
      totalText: summary?.textContent ?? '',
      sortLabel: (sortLabel?.textContent ?? '').trim(),
      dataVersion: (version?.textContent ?? '').trim(),
      scrollTop: scroll?.scrollTop ?? 0,
      scrollHeight: scroll?.scrollHeight ?? 0,
      clientHeight: scroll?.clientHeight ?? 0,
      rowHeight: Number(scroll?.getAttribute('data-row-height') ?? 'NaN'),
      reachedEnd: document.querySelector('[data-reached-end]') !== null,
    }
  })
  const rows = data.rows
    .filter((r) => r.orderNo)
    .map((r) => ({ ...r, itemCount: parseCount(r.itemCountText), totalCents: parseMoneyToCents(r.totalText) }))
  const totalCount =
    data.totalAttr !== '' && Number.isFinite(Number(data.totalAttr)) ? Number(data.totalAttr) : parseCount(data.totalText)
  return {
    rows,
    totalCount,
    sortLabel: data.sortLabel,
    dataVersion: data.dataVersion,
    scrollTop: data.scrollTop,
    scrollHeight: data.scrollHeight,
    clientHeight: data.clientHeight,
    rowHeight: data.rowHeight,
    reachedEnd: data.reachedEnd,
  }
}

export async function assertFixedSort(page: Page): Promise<void> {
  const label = ((await page.locator(S.sortLabel).first().textContent()) ?? '').trim()
  if (label !== SITE_SORT_LABEL) {
    throw new Error(`页面排序口径为「${label || '未显示'}」，期望固定口径「${SITE_SORT_LABEL}」，拒绝采集`)
  }
}

/** 滚动到指定位置，并等待页面完成重渲染（data-scroll-top 回写为目标位置附近）。 */
export async function scrollListTo(page: Page, y: number): Promise<number> {
  const target = await page.evaluate((want) => {
    const el = document.querySelector('#order-scroll') as HTMLElement | null
    if (!el) return -1
    const max = Math.max(0, el.scrollHeight - el.clientHeight)
    const clamped = Math.max(0, Math.min(max, want))
    el.scrollTop = clamped
    return clamped
  }, y)
  if (target < 0) throw new Error('列表滚动容器不存在')
  // 等待 React 提交新的 scrollTop 并渲染对应行；data-scroll-top 是渲染后的状态值。
  await page
    .waitForFunction(
      (want) => {
        const el = document.querySelector('#order-scroll') as HTMLElement | null
        const applied = Number(el?.getAttribute('data-scroll-top') ?? '-1')
        return el !== null && Math.abs(el.scrollTop - want) <= 2 && Math.abs(applied - el.scrollTop) <= 2
      },
      target,
      { timeout: 10_000 },
    )
    .catch(() => null)
  return target
}

/** 是否已滚到容器底部（页面同时渲染「已滚动到底部」提示）。 */
export async function isListAtEnd(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.querySelector('#order-scroll') as HTMLElement | null
    if (!el) return true
    const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
    return bottom && document.querySelector('[data-reached-end]') !== null
  })
}

/** 读取页面恢复后的滚动位置：页面渲染出 data-restored-scroll-top 后即返回该值。 */
export async function readRestoredScrollTop(page: Page, timeoutMs = 8000): Promise<number> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const v = await page.evaluate(() => {
      const el = document.querySelector('#order-scroll') as HTMLElement | null
      const raw = el?.getAttribute('data-restored-scroll-top') ?? ''
      if (raw !== '') return Number(raw)
      return -1
    })
    if (v >= 0) {
      // 再等一帧，确保页面自身的滚动赋值已生效
      await page.waitForTimeout(60)
      const now = await page.evaluate(() => (document.querySelector('#order-scroll') as HTMLElement | null)?.scrollTop ?? -1)
      return Math.abs(now - v) <= 2 ? now : v
    }
    await page.waitForTimeout(80)
  }
  return -1
}

// ---------------- 登录 / 过期 ----------------

// ---------------- 筛选 ----------------

export async function applyDateFilter(page: Page, from: string, to: string): Promise<void> {
  await page.fill('#from', from)
  await page.fill('#to', to)
  await Promise.all([
    page.waitForURL((u) => u.pathname === '/site/orders', { timeout: 15_000 }),
    page.click('#apply-filter'),
  ])
  await page.waitForSelector(S.scroll, { timeout: 15_000 })
  await assertFixedSort(page)
}

// ---------------- 明细 ----------------

export async function waitForDetailReady(page: Page, timeoutMs = 20_000): Promise<void> {
  await page.waitForSelector(S.detailCard, { timeout: timeoutMs })
  await page.waitForFunction(
    () => document.querySelector('#detail-card')?.getAttribute('data-detail-ready') === 'ready',
    undefined,
    { timeout: timeoutMs },
  )
  await page.waitForSelector(S.detailLines, { timeout: timeoutMs })
}

export async function readDetail(page: Page, expectOrderNo: string): Promise<ScrapedDetail> {
  const detail = await page.evaluate(() => {
    const text = (sel: string) => (document.querySelector(sel)?.textContent ?? '').trim()
    const lines: ScrapedDetail['lines'] = []
    for (const el of Array.from(document.querySelectorAll('[data-detail-line]'))) {
      const row = el as HTMLElement
      lines.push({
        lineNo: Number(row.getAttribute('data-line-no') ?? 'NaN'),
        sku: (row.querySelector('[data-sku]')?.textContent ?? '').trim(),
        name: (row.querySelector('[data-product]')?.textContent ?? '').trim(),
        unitPriceText: (row.querySelector('[data-unit-price]')?.textContent ?? '').trim(),
        quantityText: (row.querySelector('[data-quantity]')?.textContent ?? '').trim(),
        amountText: (row.querySelector('[data-line-amount]')?.textContent ?? '').trim(),
      })
    }
    return {
      orderNo: text('[data-detail-order-no]'),
      status: text('[data-detail-status]'),
      buyer: text('[data-detail-buyer]'),
      placedAt: text('[data-detail-placed-at]'),
      totalAmountText: text('[data-detail-total]'),
      itemCountText: text('[data-detail-count]'),
      lines,
    }
  })
  if (!detail.orderNo) throw new Error('明细页面上没有订单号')
  if (expectOrderNo && detail.orderNo !== expectOrderNo) {
    throw new Error(`明细页面订单号为 ${detail.orderNo}，期望 ${expectOrderNo}`)
  }
  return detail
}

// ---------------- 点击进入明细 ----------------

/** 把某订单滚到视口内并点击它的明细链接（页面上的真实操作，不构造 URL 请求）。 */
export async function openOrderDetail(page: Page, orderNo: string, index: number, savedScrollTop?: number): Promise<{ scrollTopAtClick: number }> {
  // 先回到进入明细前保存的滚动位置：页面应当能在这里找到目标订单
  const prefers = savedScrollTop ?? index * ((await readListState(page)).rowHeight || 56)
  await scrollListTo(page, prefers)
  const ensureVisible = async (y: number): Promise<boolean> => {
    await scrollListTo(page, y)
    return page.evaluate((no) => {
      const scroll = document.querySelector('#order-scroll') as HTMLElement | null
      if (!scroll) return false
      const vp = scroll.getBoundingClientRect()
      for (const el of Array.from(scroll.querySelectorAll('[data-order-row]'))) {
        if (el.getAttribute('data-order-no') !== no) continue
        const rect = el.getBoundingClientRect()
        return rect.height > 0 && rect.bottom > vp.top + 1 && rect.top < vp.bottom - 1
      }
      return false
    }, orderNo)
  }
  if (!(await ensureVisible(prefers))) {
    const tuned = await page.evaluate(({ no, idx }) => {
      const scroll = document.querySelector('#order-scroll') as HTMLElement | null
      if (!scroll) return -1
      const rh = Number(scroll.getAttribute('data-row-height') ?? '56')
      const max = scroll.scrollHeight - scroll.clientHeight
      const candidates = [idx * rh, idx * rh - scroll.clientHeight / 2, idx * rh - scroll.clientHeight + rh, idx * rh + rh]
      for (const c of candidates) {
        scroll.scrollTop = Math.max(0, Math.min(max, c))
        const vp = scroll.getBoundingClientRect()
        for (const el of Array.from(scroll.querySelectorAll('[data-order-row]'))) {
          if (el.getAttribute('data-order-no') !== no) continue
          const rect = el.getBoundingClientRect()
          if (rect.height > 0 && rect.bottom > vp.top + 1 && rect.top < vp.bottom - 1) return scroll.scrollTop
        }
      }
      return -1
    }, { no: orderNo, idx: index })
    if (tuned < 0) {
      throw new Error(`订单 ${orderNo} 未出现在可视列表中（索引 ${index}），拒绝直接构造请求进入明细`)
    }
    await scrollListTo(page, tuned)
  }
  const link = page.locator(`[data-order-row][data-order-no="${esc(orderNo)}"] [data-order-link]`).first()
  await link.waitFor({ state: 'visible', timeout: 10_000 })
  // 点击前页面自身记录的滚动位置：返回列表后页面会从这里恢复
  const scrollTopAtClick = await page.evaluate(() => {
    const el = document.querySelector('#order-scroll') as HTMLElement | null
    return el ? el.scrollTop : 0
  })
  await Promise.all([
    page.waitForURL((u) => u.pathname.startsWith('/site/orders/'), { timeout: 15_000 }),
    link.click(),
  ])
  return { scrollTopAtClick }
}

function esc(s: string): string {
  return s.replace(/["\\]/g, '\\$&')
}
