// 应用装配：站点 + 操作台共用一套 Express 实例。
// start 脚本与测试都从这里创建应用，测试才能用临时数据库/目录、监听随机端口。
import express, { type Express } from 'express'
import type { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
import { openDatabase } from './db.js'
import { readFlags } from './flags.js'
import { generateDemoData } from '../shared/demoData.js'
import { registerSite, type SiteState } from './site.js'
import { registerConsole } from './consoleRoutes.js'
import { ensureWebBuild } from './webBuild.js'

export interface HarvesterOptions {
  /** 已打开的数据库；不传则按 dbPath 新建 */
  db?: DatabaseSync
  dbPath?: string
  webDist?: string
  exportRoot: string
  screenshotDir: string
  siteUrl: string
  /** 监听端口后可以把实际站点地址回写到应用（批次标识会用这个地址） */
  seed?: number
  count?: number
  startDate?: string
  days?: number
}

export interface HarvesterApp {
  app: Express
  state: SiteState
  db: DatabaseSync
  /** 监听得到实际端口后调用，让之后创建的批次使用真实站点地址 */
  setSiteUrl: (url: string) => void
}

export async function createHarvesterApp(opts: HarvesterOptions): Promise<HarvesterApp> {
  const db = opts.db ?? openDatabase(opts.dbPath ?? 'data/app.db')
  let siteUrl = opts.siteUrl
  const webDist = opts.webDist ?? (await ensureWebBuild())

  const { orders, dataVersion } = generateDemoData({
    seed: opts.seed,
    count: opts.count,
    startDate: opts.startDate,
    days: opts.days,
  })
  const state: SiteState = {
    orders,
    dataVersion,
    snapshotAt: new Date().toISOString(),
    revision: 0,
    sessions: new Map(),
    flags: readFlags(db),
  }

  const app = express()
  registerSite(app, state, { db, webDist })
  registerConsole(app, {
    db,
    state,
    webDist,
    siteUrl: () => siteUrl,
    exportRoot: resolve(opts.exportRoot),
    screenshotDir: resolve(opts.screenshotDir),
  })
  app.get('/', (_req, res) => res.redirect('/console'))
  return { app, state, db, setSiteUrl: (url: string) => { siteUrl = url } }
}

/** 监听端口；port 传 0 时由系统分配，返回实际端口。 */
export async function listen(app: Express, port: number): Promise<{ port: number; url: string; close: () => Promise<void> }> {
  return new Promise((resolvePromise, reject) => {
    const server = app.listen(port, () => {
      const addr = server.address()
      const actual = typeof addr === 'object' && addr ? addr.port : port
      resolvePromise({
        port: actual,
        url: `http://localhost:${actual}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()))
          }),
      })
    })
    server.on('error', reject)
  })
}
