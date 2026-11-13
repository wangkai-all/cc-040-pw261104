import { resolve } from 'node:path'
import { createHarvesterApp, listen } from './app.js'
import { nowIso } from './db.js'

const PORT = Number(process.env.PORT ?? 4310)
const DB_PATH = process.env.DB_PATH ?? 'data/app.db'
const EXPORT_ROOT = resolve(process.env.EXPORT_DIR ?? 'data/exports')
const SCREENSHOT_DIR = resolve(process.env.SCREENSHOT_DIR ?? 'data/screenshots')

const { app } = await createHarvesterApp({
  dbPath: DB_PATH,
  exportRoot: EXPORT_ROOT,
  screenshotDir: SCREENSHOT_DIR,
  siteUrl: `http://localhost:${PORT}`,
  seed: Number(process.env.DEMO_SEED ?? 20261113),
  count: Number(process.env.DEMO_ORDER_COUNT ?? 300),
  startDate: process.env.DEMO_START_DATE ?? '2026-08-01',
  days: Number(process.env.DEMO_DAYS ?? 30),
})

const server = await listen(app, PORT)
console.log(`[order-harvester] 站点与操作台已启动：${server.url}  (${nowIso()})`)
console.log(`  演示站点 ${server.url}/site/login （demo / demo1234）`)
console.log(`  采集操作台 ${server.url}/console`)
console.log(`  数据库 ${DB_PATH}，导出目录 ${EXPORT_ROOT}，截图目录 ${SCREENSHOT_DIR}`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void server.close().finally(() => process.exit(0))
  })
}
