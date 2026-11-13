// 批次执行入口。同一批次同一时间只允许一个运行；重复执行时从数据库进度继续。
import type { DatabaseSync } from 'node:sqlite'
import type { BatchRow } from './db.js'
import { BatchRunner } from '../scraper/runner.js'

const active = new Map<string, Promise<unknown>>()

export function isBatchRunning(batchId: string): boolean {
  return active.has(batchId)
}

export interface RunBatchDeps {
  db: DatabaseSync
  siteUrl: string
  screenshotDir: string
}

export function runBatchInBackground(deps: RunBatchDeps, batch: BatchRow): Promise<unknown> {
  const existing = active.get(batch.id)
  if (existing) return existing
  const job = (async () => {
    const runner = new BatchRunner({ db: deps.db, siteUrl: deps.siteUrl, screenshotDir: deps.screenshotDir }, batch)
    return runner.run()
  })().finally(() => active.delete(batch.id))
  active.set(batch.id, job)
  return job
}

/** 等待全部在跑批次结束（测试与优雅退出用）。 */
export async function waitForAll(): Promise<void> {
  await Promise.allSettled([...active.values()])
}
