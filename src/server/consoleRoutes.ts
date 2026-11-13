// 操作台 API：批次创建/运行/详情/导出/截图。运行需要页面上的演示账号自动登录。
import express, { type Express, type Request, type Response } from 'express'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { SiteState } from './site.js'
import { batchSummary, createOrReuseBatch, findBatch, listBatches } from './batches.js'
import { isBatchRunning, runBatchInBackground } from './runManager.js'
import { exportBatch } from './export.js'
import { filterOrders } from './site.js'
import { DEMO_CREDENTIALS } from '../scraper/session.js'

export interface ConsoleDeps {
  db: DatabaseSync
  state: SiteState
  webDist: string
  /** 站点地址：建批次时用于冻结批次标识，可能是延迟解析的函数（监听随机端口时） */
  siteUrl: string | (() => string)
  exportRoot: string
  /** 截图根目录；数据库里存的是相对该目录的路径 */
  screenshotDir: string
}

export function registerConsole(app: Express, deps: ConsoleDeps) {
  const { db, state, webDist, exportRoot, screenshotDir } = deps
  const siteUrl = () => (typeof deps.siteUrl === 'function' ? deps.siteUrl() : deps.siteUrl)

  app.get('/console', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.type('html').send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>订单采集操作台</title>
<link rel="stylesheet" href="/assets/console.css">
</head>
<body><div id="root"></div><script type="module" src="/assets/console.js"></script></body>
</html>`)
  })
  app.get('/assets/console.js', (_req, res) => res.sendFile(resolve(webDist, 'assets/console.js')))
  app.get('/assets/console.css', (_req, res) => {
    const p = resolve(webDist, 'assets/console.css')
    if (existsSync(p)) res.sendFile(p)
    else res.status(404).type('text/css').send('/* none */')
  })

  app.get('/console/api/meta', (_req, res) => {
    const dateRange = state.orders.reduce(
      (acc, o) => ({ min: acc.min && acc.min < o.orderDate ? acc.min : o.orderDate, max: acc.max && acc.max > o.orderDate ? acc.max : o.orderDate }),
      { min: state.orders[0]?.orderDate ?? '', max: state.orders[0]?.orderDate ?? '' },
    )
    res.json({
      dataVersion: state.dataVersion,
      snapshotAt: state.snapshotAt,
      count: state.orders.length,
      allCount: state.orders.length,
      dateRange,
      flags: state.flags,
      accounts: state.flags ? [{ username: DEMO_CREDENTIALS.username, password: DEMO_CREDENTIALS.password, displayName: '演示运营账号' }] : [],
    })
  })

  app.get('/console/api/batches', (_req, res) => {
    const batches = listBatches(db).map((b) => batchSummary(db, b))
    res.json({ batches })
  })

  app.post('/console/api/batches', express.json(), (req, res) => {
    const body = req.body ?? {}
    const from = typeof body.filterFrom === 'string' ? body.filterFrom.trim() : ''
    const to = typeof body.filterTo === 'string' ? body.filterTo.trim() : ''
    if (from && to && from > to) {
      res.status(400).json({ error: '开始日期不能晚于结束日期' })
      return
    }
    const filtered = filterOrders(state.orders, from, to)
    if (filtered.length === 0) {
      res.status(400).json({ error: '该日期范围内没有订单，无法建立采集批次' })
      return
    }
    // 批次冻结：快照时刻取当前时刻，之后新建的订单不加入本批
    const snapshotAt = new Date().toISOString()
    const snapshotMaxPlacedAtMs = Date.now()
    const result = createOrReuseBatch(db, {
      siteUrl: siteUrl(),
      filterFrom: from,
      filterTo: to,
      dataVersion: state.dataVersion,
      expectedCount: filtered.length,
      snapshotMaxPlacedAtMs,
    })
    if (!result.reused) {
      db.prepare('UPDATE batches SET snapshot_max_placed_at_ms = ? WHERE id = ?').run(snapshotMaxPlacedAtMs, result.batch.id)
    }
    res.json({ batch: batchSummary(db, result.batch), reused: result.reused, snapshotAt })
  })

  const startRun = async (req: Request, res: Response, mode: 'run' | 'retry') => {
    const id = String(req.params.id)
    const batch = findBatch(db, id)
    if (!batch) {
      res.status(404).json({ error: '批次不存在' })
      return
    }
    if (isBatchRunning(id)) {
      res.status(409).json({ error: '该批次正在运行，请稍候' })
      return
    }
    if (mode === 'retry') {
      db.prepare("UPDATE orders SET phase = 'pending', last_error = NULL WHERE batch_id = ? AND phase = 'failed'").run(id)
      db.prepare("DELETE FROM exceptions WHERE batch_id = ? AND code IN ('DETAIL_FAILED','LOGIN_EXPIRED')").run(id)
    }
    try {
      const outcome = await runBatchInBackground({ db, siteUrl: siteUrl(), screenshotDir }, batch)
      res.json({ outcome, batch: batchSummary(db, findBatch(db, id)!) })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  }

  app.post('/console/api/batches/:id/run', (req, res) => startRun(req, res, 'run'))
  app.post('/console/api/batches/:id/retry', (req, res) => startRun(req, res, 'retry'))

  app.get('/console/api/batches/:id', (req, res) => {
    const id = String(req.params.id)
    const batch = findBatch(db, id)
    if (!batch) {
      res.status(404).json({ error: '批次不存在' })
      return
    }
    const ordersRaw = db
      .prepare(
        `SELECT id, order_no, placed_at, buyer, status, total_text, item_count_text, phase, attempt_count, last_error, screenshot_path, issues_json, detailed_at
         FROM orders WHERE batch_id = ? ORDER BY placed_at_ms DESC, order_no DESC`,
      )
      .all(id) as Record<string, unknown>[]
    const linesRaw = db
      .prepare(
        `SELECT l.order_id, l.line_no, l.sku, l.name, l.unit_price_cents, l.quantity, l.amount_cents, l.line_sum_ok
         FROM order_lines l JOIN orders o ON o.id = l.order_id WHERE o.batch_id = ? ORDER BY l.line_no ASC`,
      )
      .all(id) as Record<string, unknown>[]
    const linesByOrder = new Map<number, unknown[]>()
    for (const l of linesRaw) {
      const key = Number(l.order_id)
      if (!linesByOrder.has(key)) linesByOrder.set(key, [])
      linesByOrder.get(key)!.push({
        lineNo: l.line_no,
        sku: l.sku,
        name: l.name,
        unitPrice: `¥${(Number(l.unit_price_cents) / 100).toFixed(2)}`,
        quantity: String(l.quantity),
        amount: `¥${(Number(l.amount_cents) / 100).toFixed(2)}`,
        ok: Number(l.line_sum_ok) === 1,
      })
    }
    const orders = ordersRaw.map((o) => ({
      id: Number(o.id),
      orderNo: o.order_no,
      placedAt: o.placed_at,
      buyer: o.buyer,
      status: o.status,
      totalText: o.total_text,
      itemCountText: o.item_count_text,
      phase: o.phase,
      attemptCount: Number(o.attempt_count),
      lastError: o.last_error,
      screenshotPath: o.screenshot_path,
      issues: parseIssues(o.issues_json),
      lines: linesByOrder.get(Number(o.id)) ?? [],
    }))
    const exceptions = db
      .prepare('SELECT id, order_no, code, severity, message, created_at, screenshot_path FROM exceptions WHERE batch_id = ? ORDER BY id ASC')
      .all(id) as Record<string, unknown>[]
    const runs = db
      .prepare('SELECT id, status, reason, started_at, finished_at, collected_count, detail_count FROM runs WHERE batch_id = ? ORDER BY id DESC')
      .all(id) as Record<string, unknown>[]
    res.json({
      batch: batchSummary(db, batch),
      orders,
      exceptions: exceptions.map((e) => ({
        id: Number(e.id),
        orderNo: e.order_no,
        code: e.code,
        severity: e.severity,
        message: e.message,
        createdAt: e.created_at,
        screenshotPath: e.screenshot_path,
      })),
      runs: runs.map((r) => ({
        id: Number(r.id),
        status: r.status,
        reason: r.reason,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        collectedCount: Number(r.collected_count),
        detailCount: Number(r.detail_count),
      })),
    })
  })

  app.post('/console/api/batches/:id/export', async (req, res) => {
    const batch = findBatch(db, String(req.params.id))
    if (!batch) return void res.status(404).json({ error: '批次不存在' })
    const files = await exportBatch(db, batch, exportRoot, screenshotDir)
    res.json(files)
  })

  app.get('/console/api/batches/:id/export/zip', async (req, res) => {
    const batch = findBatch(db, String(req.params.id))
    if (!batch) return void res.status(404).end()
    const files = await exportBatch(db, batch, exportRoot, screenshotDir)
    res.download(files.zip, `${batch.id}.zip`)
  })

  app.get('/console/api/batches/:id/export/:kind', async (req, res) => {
    const batch = findBatch(db, String(req.params.id))
    if (!batch) return void res.status(404).end()
    const kind = String(req.params.kind)
    if (kind !== 'orders' && kind !== 'lines' && kind !== 'exceptions') return void res.status(400).end()
    const files = await exportBatch(db, batch, exportRoot, screenshotDir)
    const path = kind === 'orders' ? files.ordersCsv : kind === 'lines' ? files.linesCsv : files.exceptionsCsv
    res.download(path)
  })

  // 截图/导出文件：只允许访问截图根目录与导出根目录内的文件。
  // 截图路径入库存的是相对截图根目录的值（如 <batchId>/<orderNo>.png）。
  app.get('/console/api/files/*path', (req, res) => {
    const raw = (req.params as Record<string, string | string[]>).path
    const rel = Array.isArray(raw) ? raw.join('/') : String(raw ?? '')
    const candidates = [resolve(screenshotDir, rel), resolve(exportRoot, rel), resolve(rel)]
    const inside = (base: string, abs: string) => {
      const root = resolve(base)
      return abs === root || abs.startsWith(root + '/')
    }
    const abs = candidates.find((c) => inside(screenshotDir, c) || inside(exportRoot, c))
    if (!abs) return void res.status(403).end()
    if (!existsSync(abs)) return void res.status(404).end()
    res.sendFile(abs)
  })
}

function parseIssues(json: unknown): { code: string; severity: string; message: string }[] {
  if (typeof json !== 'string' || !json) return []
  try {
    const parsed = JSON.parse(json) as { issues?: { code?: string; severity?: string; message?: string }[] }
    return (parsed.issues ?? []).map((i) => ({ code: i.code ?? '', severity: i.severity ?? 'error', message: i.message ?? '' }))
  } catch {
    return []
  }
}
