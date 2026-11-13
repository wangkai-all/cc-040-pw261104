// 导出：订单 CSV、明细 CSV、异常清单 CSV，并打包为 zip。
import { createWriteStream } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import archiver from 'archiver'
import type { DatabaseSync } from 'node:sqlite'
import { centsToPlain } from '../shared/money.js'
import type { BatchRow } from './db.js'

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function csv(rows: unknown[][]): string {
  return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n') + '\r\n'
}

export interface ExportFiles {
  dir: string
  ordersCsv: string
  linesCsv: string
  exceptionsCsv: string
  zip: string
}

export async function exportBatch(db: DatabaseSync, batch: BatchRow, outRoot: string, screenshotDir?: string): Promise<ExportFiles> {
  const dir = resolve(outRoot, batch.id)
  await mkdir(dir, { recursive: true })

  const orders = db
    .prepare(
      `SELECT order_no, placed_at, buyer, status, total_text, item_count_text, phase, attempt_count, last_error, detailed_at, screenshot_path
       FROM orders WHERE batch_id = ? ORDER BY placed_at_ms DESC, order_no DESC`,
    )
    .all(batch.id) as Record<string, unknown>[]

  const ordersCsv = resolve(dir, 'orders.csv')
  await writeFile(
    ordersCsv,
    '﻿' +
      csv([
        ['订单号', '下单时间', '买家', '状态', '订单总额(页面文本)', '明细项数(页面文本)', '采集状态', '尝试次数', '失败原因', '明细采集时间', '截图'],
        ...orders.map((o) => [
          o.order_no,
          o.placed_at,
          o.buyer,
          o.status,
          o.total_text,
          o.item_count_text,
          phaseLabel(String(o.phase)),
          o.attempt_count,
          o.last_error,
          o.detailed_at,
          o.screenshot_path,
        ]),
      ]),
    'utf8',
  )

  const lines = db
    .prepare(
      `SELECT o.order_no, l.line_no, l.sku, l.name, l.unit_price_cents, l.quantity, l.amount_cents, l.line_sum_ok
       FROM order_lines l JOIN orders o ON o.id = l.order_id
       WHERE o.batch_id = ? ORDER BY o.placed_at_ms DESC, o.order_no DESC, l.line_no ASC`,
    )
    .all(batch.id) as Record<string, unknown>[]

  const linesCsv = resolve(dir, 'order_lines.csv')
  await writeFile(
    linesCsv,
    '﻿' +
      csv([
        ['订单号', '行号', '商品编码', '商品名称', '单价', '数量', '行金额', '单价乘数量核对'],
        ...lines.map((l) => [
          l.order_no,
          l.line_no,
          l.sku,
          l.name,
          centsToPlain(Number(l.unit_price_cents)),
          l.quantity,
          centsToPlain(Number(l.amount_cents)),
          Number(l.line_sum_ok) === 1 ? '一致' : '不一致',
        ]),
      ]),
    'utf8',
  )

  const exceptions = db
    .prepare('SELECT order_no, code, severity, message, created_at, screenshot_path FROM exceptions WHERE batch_id = ? ORDER BY id ASC')
    .all(batch.id) as Record<string, unknown>[]

  const exceptionsCsv = resolve(dir, 'exceptions.csv')
  await writeFile(
    exceptionsCsv,
    '﻿' +
      csv([
        ['订单号', '异常代码', '级别', '说明', '发生时间', '截图'],
        ...exceptions.map((e) => [e.order_no ?? '（批次级）', e.code, e.severity === 'error' ? '错误' : '警告', e.message, e.created_at, e.screenshot_path]),
      ]),
    'utf8',
  )

  const summary = {
    batch: {
      id: batch.id,
      name: batch.name,
      filterFrom: batch.filterFrom,
      filterTo: batch.filterTo,
      expectedCount: batch.expectedCount,
      dataVersion: batch.dataVersion,
      snapshotMaxPlacedAtMs: batch.snapshotMaxPlacedAtMs,
      sort: `${batch.sortField} ${batch.sortDirection}`,
    },
    orders: orders.length,
    lines: lines.length,
    exceptions: exceptions.length,
  }
  await writeFile(resolve(dir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8')

  const zip = resolve(dir, `${batch.id}.zip`)
  await new Promise<void>((resolvePromise, reject) => {
    const output = createWriteStream(zip)
    const archive = archiver('zip', { zlib: { level: 9 } })
    output.on('close', () => resolvePromise())
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    archive.file(ordersCsv, { name: 'orders.csv' })
    archive.file(linesCsv, { name: 'order_lines.csv' })
    archive.file(exceptionsCsv, { name: 'exceptions.csv' })
    archive.file(resolve(dir, 'summary.json'), { name: 'summary.json' })
    for (const o of orders) {
      const shot = o.screenshot_path ? String(o.screenshot_path) : ''
      if (shot) archive.file(resolve(screenshotDir ?? '.', shot), { name: `screenshots/${String(o.order_no)}.png` })
    }
    void archive.finalize()
  })

  return { dir, ordersCsv, linesCsv, exceptionsCsv, zip }
}

function phaseLabel(phase: string): string {
  switch (phase) {
    case 'verified':
      return '已核对'
    case 'failed':
      return '核对失败'
    case 'detail_done':
      return '明细已采'
    default:
      return '待采集'
  }
}
