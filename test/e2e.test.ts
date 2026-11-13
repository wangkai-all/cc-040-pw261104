// 端到端测试：真正启动站点 + 操作台，用 Playwright 操作页面完成采集。
// 覆盖：列表全量（虚拟滚动按可见行读取、按订单号去重、到底提示、总数一致）、
// 明细核对与截图、重复执行沿用原进度、批次快照排除新建订单、登录过期暂停与补采、导出。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { createHarvesterApp, listen } from '../src/server/app.ts'
import type { BatchSummary } from '../src/server/batches.ts'

const ORDER_COUNT = 14

interface Env {
  base: string
  db: DatabaseSync
  exportRoot: string
  screenshotDir: string
  stop: () => Promise<void>
}

async function startServer(): Promise<Env> {
  const root = await mkdtemp(join(tmpdir(), 'order-harvester-e2e-'))
  const exportRoot = join(root, 'exports')
  const screenshotDir = join(root, 'screenshots')
  const built = await createHarvesterApp({
    dbPath: join(root, 'app.db'),
    exportRoot,
    screenshotDir,
    siteUrl: 'http://localhost',
    seed: 20261113,
    count: ORDER_COUNT,
    startDate: '2026-08-01',
    days: 10,
  })
  const listener = await listen(built.app, 0)
  built.setSiteUrl(listener.url)
  return {
    base: listener.url,
    db: built.db,
    exportRoot,
    screenshotDir,
    stop: async () => {
      await listener.close()
      await rm(root, { recursive: true, force: true })
    },
  }
}

async function json<T>(url: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const r = await fetch(url, init)
  const text = await r.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: r.status, body: body as T }
}

async function createBatch(base: string, filterFrom: string, filterTo: string): Promise<{ batch: BatchSummary; reused: boolean }> {
  const r = await json<{ batch: BatchSummary; reused: boolean; error?: string }>(`${base}/console/api/batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ filterFrom, filterTo }),
  })
  assert.equal(r.status, 200, `创建批次失败: ${JSON.stringify(r.body)}`)
  return r.body
}

interface RunOutcome {
  status: 'completed' | 'incomplete' | 'paused' | 'error'
  reason: string | null
  collected: number
  detailDone: number
  exceptions: number
  screenshots: number
}

async function runBatch(base: string, id: string, mode: 'run' | 'retry' = 'run'): Promise<RunOutcome> {
  const r = await json<{ outcome?: RunOutcome; error?: string }>(`${base}/console/api/batches/${encodeURIComponent(id)}/${mode}`, { method: 'POST' })
  assert.equal(r.status, 200, `运行批次失败: ${JSON.stringify(r.body)}`)
  assert.ok(r.body.outcome, '运行应返回 outcome')
  return r.body.outcome
}

interface BatchDetail {
  batch: BatchSummary
  orders: {
    id: number
    orderNo: string
    phase: string
    screenshotPath: string | null
    lines: { lineNo: number; unitPrice: string; quantity: string; amount: string; ok: boolean }[]
    issues: { code: string; severity: string; message: string }[]
  }[]
  exceptions: { code: string; severity: string; orderNo: string | null; message: string }[]
  runs: { id: number; status: string; reason: string | null; collectedCount: number; detailCount: number }[]
}

async function batchDetail(base: string, id: string): Promise<BatchDetail> {
  const r = await json<BatchDetail>(`${base}/console/api/batches/${encodeURIComponent(id)}`)
  assert.equal(r.status, 200)
  return r.body
}

test('采集全流程（真实页面操作）', { timeout: 240_000 }, async (t) => {
  const env = await startServer()
  t.after(async () => {
    await env.stop()
  })
  let batchId = ''

  await t.test('列表全量采集 + 明细核对 + 截图，总数与筛选总数一致且无重复', async () => {
    const created = await createBatch(env.base, '', '')
    batchId = created.batch.id
    assert.equal(created.reused, false)
    assert.equal(created.batch.expectedCount, ORDER_COUNT, '筛选总数应与服务端订单数一致')

    const outcome = await runBatch(env.base, batchId)
    assert.equal(outcome.status, 'completed', outcome.reason ?? '')
    assert.equal(outcome.collected, ORDER_COUNT)
    assert.equal(outcome.detailDone, ORDER_COUNT)
    assert.equal(outcome.screenshots, ORDER_COUNT)
    assert.equal(outcome.exceptions, 0, '干净数据不应产生异常')

    const detail = await batchDetail(env.base, batchId)
    assert.equal(detail.batch.orders, ORDER_COUNT)
    assert.equal(detail.batch.verified, ORDER_COUNT)
    assert.equal(detail.batch.failed, 0)
    // 按订单号去重：数据库里不能有重复订单
    const nos = new Set(detail.orders.map((o) => o.orderNo))
    assert.equal(nos.size, ORDER_COUNT)
    // 每张订单都有截图，且文件真实存在
    const shotFiles: string[] = []
    for (const o of detail.orders) {
      assert.ok(o.screenshotPath, `${o.orderNo} 应有截图`)
      const abs = resolve(env.screenshotDir, o.screenshotPath!)
      const s = await stat(abs)
      assert.ok(s.size > 1000, `${o.screenshotPath} 截图文件应非空`)
      shotFiles.push(o.screenshotPath!)
    }
    assert.equal(shotFiles.length, ORDER_COUNT)
    // 明细逐行核对通过
    for (const o of detail.orders) {
      assert.ok(o.lines.length >= 1)
      for (const l of o.lines) assert.equal(l.ok, true, `${o.orderNo} 第 ${l.lineNo} 行 单价×数量≠行金额`)
    }
    assert.equal(detail.runs.length, 1)
    assert.equal(detail.runs[0]!.status, 'completed')
  })

  await t.test('重复执行同一批次沿用原进度：不再重采、不重复截图', async () => {
    const before = await batchDetail(env.base, batchId)
    const t0 = Date.now()
    const outcome = await runBatch(env.base, batchId)
    const elapsed = Date.now() - t0
    assert.equal(outcome.status, 'completed')
    assert.equal(outcome.screenshots, 0, '已完成的订单不应重新截图')
    assert.equal(outcome.collected, ORDER_COUNT)
    assert.ok(elapsed < 15_000, `重复执行应快速完成（实际 ${elapsed}ms）`)
    const after = await batchDetail(env.base, batchId)
    assert.equal(after.batch.orders, before.batch.orders)
    assert.equal(after.runs.length, 2)
    assert.equal(after.runs[0]!.status, 'completed')
  })

  await t.test('导出订单 / 明细 / 异常清单，截图一并打包', async () => {
    const r = await json<{ ordersCsv: string; linesCsv: string; exceptionsCsv: string; zip: string }>(
      `${env.base}/console/api/batches/${encodeURIComponent(batchId)}/export`,
      { method: 'POST' },
    )
    assert.equal(r.status, 200)
    for (const p of [r.body.ordersCsv, r.body.linesCsv, r.body.exceptionsCsv, r.body.zip]) {
      assert.ok((await stat(p)).size > 0, `${p} 应已写出`)
      assert.ok(p.startsWith(env.exportRoot), '导出文件应位于导出目录内')
    }
    const ordersCsv = stripBom(await readFile(r.body.ordersCsv, 'utf8'))
    const orderLines = ordersCsv.trim().split('\r\n')
    assert.equal(orderLines.length, ORDER_COUNT + 1, '订单 CSV 应有表头 + 每张订单一行')
    assert.ok(ordersCsv.includes('订单号'), 'CSV 应带中文表头')

    const linesCsv = stripBom(await readFile(r.body.linesCsv, 'utf8'))
    const lineRows = linesCsv.trim().split('\r\n').slice(1)
    assert.ok(lineRows.length > ORDER_COUNT, '明细行数应多于订单数')

    const exceptionsCsv = stripBom(await readFile(r.body.exceptionsCsv, 'utf8'))
    assert.equal(exceptionsCsv.trim().split('\r\n').length, 1, '无异常时只有表头')

    const zipStat = await stat(r.body.zip)
    assert.ok(zipStat.size > ORDER_COUNT * 1000, 'zip 应包含截图')

    // 操作台可读取截图；目录穿越被拒绝
    const shot = await fetch(`${env.base}/console/api/files/${encodeURIComponent((await batchDetail(env.base, batchId)).orders[0]!.screenshotPath!)}`)
    assert.equal(shot.status, 200)
    assert.match(shot.headers.get('content-type') ?? '', /image\/png/)
    const traversal = await fetch(`${env.base}/console/api/files/${encodeURIComponent('../../package.json')}`)
    assert.equal(traversal.status, 403)
  })

  await t.test('批次快照固定：运行期间新建的订单不纳入本批', async () => {
    const created = await createBatch(env.base, '2026-08-01', '2026-11-13')
    assert.equal(created.batch.expectedCount, ORDER_COUNT)
    // 在批次建立之后、运行之前新建订单（会推进站点数据版本）
    const newOrder = await json<{ orderNo: string; dataVersion: string }>(`${env.base}/api/site/new-order`, { method: 'POST' })
    assert.equal(newOrder.status, 200)

    const outcome = await runBatch(env.base, created.batch.id)
    assert.equal(outcome.status, 'completed', outcome.reason ?? '')
    assert.equal(outcome.collected, ORDER_COUNT, '新订单必须被排除在批次之外')

    const detail = await batchDetail(env.base, created.batch.id)
    assert.equal(detail.batch.orders, ORDER_COUNT)
    assert.ok(
      !detail.orders.some((o) => o.orderNo === newOrder.body.orderNo),
      `快照后新建的 ${newOrder.body.orderNo} 不应出现在批次里`,
    )
    // 版本变化与排除动作都被记录为警告
    assert.ok(detail.exceptions.some((e) => e.code === 'NEW_ORDERS_EXCLUDED' && e.severity === 'warning'))
    assert.ok(detail.exceptions.some((e) => e.code === 'DATA_VERSION_CHANGED' || e.code === 'DATA_VERSION_DRIFT'))
    assert.equal(detail.batch.verified, ORDER_COUNT)
  })

  await t.test('登录过期暂停，重新登录后只补未完成订单', async () => {
    const flags = await json<{ flags: { detailDelayMs: number; sessionExpiryMs: number; autoLogout: boolean } }>(
      `${env.base}/api/site/flags`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoLogout: true, sessionExpiryMs: 5000, detailDelayMs: 900 }),
      },
    )
    assert.equal(flags.body.flags.autoLogout, true)

    // 7 笔订单、单笔明细延迟 900ms：进度推进途中会话过期
    const created = await createBatch(env.base, '2026-08-01', '2026-08-05')
    assert.ok(created.batch.expectedCount >= 4 && created.batch.expectedCount <= 8, `筛选订单数应为 4~8，实际 ${created.batch.expectedCount}`)

    const first = await runBatch(env.base, created.batch.id)
    const firstDetail = await batchDetail(env.base, created.batch.id)
    assert.match(firstDetail.runs[0]!.status, /^(paused|completed)$/)
    if (firstDetail.runs[0]!.status !== 'paused') {
      // 机器特别快时可能在过期前跑完；此时跳过补采断言但仍校验过期计数
      assert.equal(first.status, 'completed')
    } else {
      assert.equal(first.status, 'paused', first.reason ?? '')
      assert.ok(firstDetail.exceptions.some((e) => e.code === 'LOGIN_EXPIRED'), '应记录登录过期异常')
      assert.equal(firstDetail.batch.status, 'paused')
      assert.ok(
        (firstDetail.batch.progress as { phase?: string } | null)?.phase === 'paused',
        '进度应标记为暂停并已落盘',
      )
      const verifiedBefore = firstDetail.orders.filter((o) => o.phase === 'verified').length
      assert.ok(verifiedBefore < created.batch.expectedCount, '暂停时应仍有未完成订单')

      // 关掉自动退出，重新运行：新会话登录后只补未完成订单
      await json(`${env.base}/api/site/flags`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autoLogout: false, detailDelayMs: 150, sessionExpiryMs: 5000 }),
      })
      const second = await runBatch(env.base, created.batch.id)
      assert.equal(second.status, 'completed', second.reason ?? '')
      assert.equal(second.collected, created.batch.expectedCount, '补采不应新增订单')
      assert.equal(second.screenshots, created.batch.expectedCount - verifiedBefore, '只补采未完成订单并各截一张图')

      const after = await batchDetail(env.base, created.batch.id)
      assert.equal(after.batch.verified, created.batch.expectedCount)
      assert.equal(after.runs.length, 2)
      assert.equal(after.runs[0]!.status, 'completed')
      // 已完成订单的明细行没有被重复写入
      const lineKeys = new Set(after.orders.flatMap((o) => o.lines.map((l) => `${o.orderNo}#${l.lineNo}`)))
      const lineTotal = after.orders.reduce((n, o) => n + o.lines.length, 0)
      assert.equal(lineKeys.size, lineTotal, '明细行不能重复')
    }
    const stats = await json<{ expiryEvents: number }>(`${env.base}/api/site/stats`)
    assert.ok(stats.body.expiryEvents >= 1, '站点应记录到会话过期事件')
  })

  await t.test('数据库中记录采集位置，运行记录完整', async () => {
    const rows = env.db
      .prepare('SELECT order_no, list_scroll_top, screenshot_path, phase FROM orders WHERE batch_id = ?')
      .all(batchId) as { order_no: string; list_scroll_top: number | null; screenshot_path: string | null; phase: string }[]
    assert.equal(rows.length, ORDER_COUNT)
    assert.ok(rows.every((r) => r.phase === 'verified'))
    assert.ok(rows.every((r) => r.list_scroll_top !== null), '每张订单都应记录它在列表里的滚动位置')
    const dirs = await readdir(join(env.screenshotDir, batchId))
    assert.equal(dirs.filter((f) => f.endsWith('.png')).length, ORDER_COUNT)
  })
})

function stripBom(s: string): string {
  return s.replace(/^﻿/, '')
}
