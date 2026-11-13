// SQLite 持久层：采集批次（冻结筛选范围与站点数据版本）、订单采集结果、明细、异常、运行记录。
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface BatchRow {
  id: string
  name: string
  siteUrl: string
  dataVersion: string
  filterFrom: string
  filterTo: string
  expectedCount: number
  snapshotMaxPlacedAtMs: number
  sortField: string
  sortDirection: string
  status: string
  progressJson: string | null
  storageStateJson: string | null
  createdAt: string
  updatedAt: string
  note: string | null
  lastRunId: number | null
}

export interface OrderRow {
  id: number
  batchId: string
  orderNo: string
  placedAt: string
  placedAtMs: number
  buyer: string
  status: string
  totalText: string
  itemCountText: string
  listScrollTop: number | null
  listIndex: number | null
  phase: 'pending' | 'detail_done' | 'verified' | 'failed' | 'skipped'
  attemptCount: number
  lastError: string | null
  screenshotPath: string | null
  issuesJson: string | null
  detailedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface LineRow {
  orderId: number
  lineNo: number
  sku: string
  name: string
  unitPriceCents: number
  quantity: number
  amountCents: number
  lineSumOk: number
}

export interface ExceptionRow {
  id: number
  batchId: string
  orderNo: string | null
  code: string
  severity: 'error' | 'warning'
  message: string
  createdAt: string
  screenshotPath: string | null
}

export interface RunRow {
  id: number
  batchId: string
  startedAt: string
  finishedAt: string | null
  status: string
  reason: string | null
  collectedCount: number
  detailCount: number
  exceptionCount: number
  screenshots: number
  progressJson: string | null
}

export interface BatchProgress {
  /** 采集列表时当前滚动位置（采集端进入明细前保存，返回后继续） */
  scrollTop: number
  /** 当前列表收集到的行索引信息 */
  listIndex: number
  filterFrom: string
  filterTo: string
  sortField: string
  sortDirection: string
  /** 已见过的订单号（用于断点续采，按订单号去重） */
  collectedOrderNos: string[]
  /** 因数据版本变化而被排除的新订单数 */
  skippedNewerCount: number
  /** 当前正在采集的订单号 */
  currentOrderNo: string | null
  phase: 'init' | 'list' | 'detail' | 'done' | 'paused'
  savedAt: string
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  site_url TEXT NOT NULL,
  data_version TEXT NOT NULL DEFAULT '',
  filter_from TEXT NOT NULL,
  filter_to TEXT NOT NULL,
  expected_count INTEGER NOT NULL DEFAULT 0,
  snapshot_max_placed_at_ms INTEGER NOT NULL DEFAULT 0,
  sort_field TEXT NOT NULL DEFAULT 'placedAt',
  sort_direction TEXT NOT NULL DEFAULT 'desc',
  status TEXT NOT NULL,
  progress_json TEXT,
  storage_state_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  note TEXT,
  last_run_id INTEGER
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  order_no TEXT NOT NULL,
  placed_at TEXT NOT NULL,
  placed_at_ms INTEGER NOT NULL,
  buyer TEXT NOT NULL,
  status TEXT NOT NULL,
  total_text TEXT NOT NULL,
  item_count_text TEXT NOT NULL,
  list_scroll_top INTEGER,
  list_index INTEGER,
  phase TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  screenshot_path TEXT,
  issues_json TEXT,
  detailed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (batch_id, order_no)
);
CREATE TABLE IF NOT EXISTS order_lines (
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  line_sum_ok INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (order_id, line_no)
);
CREATE TABLE IF NOT EXISTS exceptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  order_no TEXT,
  code TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  screenshot_path TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL,
  reason TEXT,
  collected_count INTEGER NOT NULL DEFAULT 0,
  detail_count INTEGER NOT NULL DEFAULT 0,
  exception_count INTEGER NOT NULL DEFAULT 0,
  screenshots INTEGER NOT NULL DEFAULT 0,
  progress_json TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS site_login_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS site_expiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_batch_phase ON orders(batch_id, phase);
CREATE INDEX IF NOT EXISTS idx_orders_batch_sort ON orders(batch_id, placed_at_ms DESC, order_no DESC);
CREATE INDEX IF NOT EXISTS idx_exceptions_batch ON exceptions(batch_id);
CREATE INDEX IF NOT EXISTS idx_runs_batch ON runs(batch_id);
`

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  db.exec(SCHEMA)
  return db
}

export function nowIso(): string {
  return new Date().toISOString()
}

export function parseProgress(row: BatchRow | { progress_json: string | null }): BatchProgress | null {
  const raw = 'progress_json' in row ? row.progress_json : (row as BatchRow).progressJson
  if (!raw) return null
  try {
    return JSON.parse(raw) as BatchProgress
  } catch {
    return null
  }
}
