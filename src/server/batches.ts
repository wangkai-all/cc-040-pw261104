// 批次管理：每个批次冻结筛选范围、固定排序口径与站点数据版本快照。
// 同一筛选范围重复建批时沿用已有批次（原进度继续），保证「重复执行同一批次也沿用原进度」。
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { nowIso, type BatchRow } from './db.js'

export interface CreateBatchInput {
  name?: string
  siteUrl: string
  filterFrom: string
  filterTo: string
  dataVersion: string
  expectedCount: number
  snapshotMaxPlacedAtMs: number
}

export function batchIdentity(input: Pick<CreateBatchInput, 'siteUrl' | 'filterFrom' | 'filterTo'>): string {
  const h = createHash('sha256')
    .update(`${input.siteUrl}|${input.filterFrom}|${input.filterTo}`)
    .digest('hex')
    .slice(0, 10)
  const range = `${input.filterFrom || 'all'}~${input.filterTo || 'all'}`
  return `${range}-${h}`
}

export function findBatch(db: DatabaseSync, id: string): BatchRow | null {
  const row = db.prepare('SELECT * FROM batches WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? toBatchRow(row) : null
}

export function listBatches(db: DatabaseSync): BatchRow[] {
  const rows = db.prepare('SELECT * FROM batches ORDER BY created_at DESC').all() as Record<string, unknown>[]
  return rows.map(toBatchRow)
}

function toBatchRow(r: Record<string, unknown>): BatchRow {
  return {
    id: String(r.id),
    name: String(r.name),
    siteUrl: String(r.site_url),
    dataVersion: String(r.data_version ?? ''),
    filterFrom: String(r.filter_from ?? ''),
    filterTo: String(r.filter_to ?? ''),
    expectedCount: Number(r.expected_count ?? 0),
    snapshotMaxPlacedAtMs: Number(r.snapshot_max_placed_at_ms ?? 0),
    sortField: String(r.sort_field ?? 'placedAt'),
    sortDirection: String(r.sort_direction ?? 'desc'),
    status: String(r.status ?? 'draft'),
    progressJson: r.progress_json === null || r.progress_json === undefined ? null : String(r.progress_json),
    storageStateJson: null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    note: r.note === null || r.note === undefined ? null : String(r.note),
    lastRunId: r.last_run_id === null || r.last_run_id === undefined ? null : Number(r.last_run_id),
  }
}

/** 新建或沿用批次。同一站点 + 同一筛选范围视为同一批次。 */
export function createOrReuseBatch(db: DatabaseSync, input: CreateBatchInput): { batch: BatchRow; reused: boolean } {
  const id = batchIdentity(input)
  const existing = findBatch(db, id)
  if (existing) {
    // 沿用原进度：只刷新数据版本/总数的元信息，不动已采结果
    db.prepare('UPDATE batches SET updated_at = ?, note = COALESCE(note, ?) WHERE id = ?').run(nowIso(), input.name ?? null, id)
    return { batch: findBatch(db, id)!, reused: true }
  }
  const now = nowIso()
  db.prepare(
    `INSERT INTO batches (id, name, site_url, data_version, filter_from, filter_to, expected_count, snapshot_max_placed_at_ms, sort_field, sort_direction, status, created_at, updated_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'placedAt', 'desc', 'draft', ?, ?, NULL)`,
  ).run(
    id,
    input.name ?? `批次 ${input.filterFrom || '全部'} ~ ${input.filterTo || '全部'}`,
    input.siteUrl,
    input.dataVersion,
    input.filterFrom,
    input.filterTo,
    input.expectedCount,
    input.snapshotMaxPlacedAtMs,
    now,
    now,
  )
  return { batch: findBatch(db, id)!, reused: false }
}

export interface BatchSummary {
  id: string
  name: string
  siteUrl: string
  filterFrom: string
  filterTo: string
  expectedCount: number
  dataVersion: string
  status: string
  createdAt: string
  updatedAt: string
  orders: number
  verified: number
  failed: number
  pending: number
  exceptions: number
  screenshots: number
  progress: unknown
  lastRun: { id: number; status: string; reason: string | null; startedAt: string; finishedAt: string | null } | null
}

export function batchSummary(db: DatabaseSync, batch: BatchRow): BatchSummary {
  const counts = db
    .prepare(
      `SELECT phase, COUNT(*) AS n FROM orders WHERE batch_id = ? GROUP BY phase`,
    )
    .all(batch.id) as { phase: string; n: number }[]
  const byPhase = new Map(counts.map((c) => [c.phase, Number(c.n)]))
  const exceptions = Number((db.prepare('SELECT COUNT(*) AS n FROM exceptions WHERE batch_id = ?').get(batch.id) as { n: number }).n)
  const screenshots = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM orders WHERE batch_id = ? AND screenshot_path IS NOT NULL").get(batch.id) as { n: number }).n,
  )
  const lastRun = batch.lastRunId
    ? (db.prepare('SELECT id, status, reason, started_at, finished_at FROM runs WHERE id = ?').get(batch.lastRunId) as
        | { id: number; status: string; reason: string | null; started_at: string; finished_at: string | null }
        | undefined)
    : undefined
  let progress: unknown = null
  if (batch.progressJson) {
    try {
      progress = JSON.parse(batch.progressJson)
    } catch {
      progress = null
    }
  }
  return {
    id: batch.id,
    name: batch.name,
    siteUrl: batch.siteUrl,
    filterFrom: batch.filterFrom,
    filterTo: batch.filterTo,
    expectedCount: batch.expectedCount,
    dataVersion: batch.dataVersion,
    status: batch.status,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    orders: [...byPhase.values()].reduce((a, b) => a + b, 0),
    verified: byPhase.get('verified') ?? 0,
    failed: byPhase.get('failed') ?? 0,
    pending: byPhase.get('pending') ?? 0,
    exceptions,
    screenshots,
    progress,
    lastRun: lastRun
      ? { id: lastRun.id, status: lastRun.status, reason: lastRun.reason, startedAt: lastRun.started_at, finishedAt: lastRun.finished_at }
      : null,
  }
}

