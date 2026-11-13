// 采集配置：站点、登录账号、延迟明细与自动退出登录开关。
// 这些开关由操作台（演示站点的「控制台」页）维护，采集端每批开始时读取一次。
import type { DatabaseSync } from 'node:sqlite'

export interface DemoFlags {
  /** 明细加载延迟（毫秒），0 表示立即 */
  detailDelayMs: number
  /** 自动退出登录：会话经过 N 毫秒后过期 */
  sessionExpiryMs: number
  /** 是否启用自动退出 */
  autoLogout: boolean
}

export const DEFAULT_FLAGS: DemoFlags = {
  detailDelayMs: 120,
  sessionExpiryMs: 45_000,
  autoLogout: false,
}

const SETTINGS_KEY = 'demo_flags'

export function readFlags(db: DatabaseSync): DemoFlags {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined
  if (!row) return { ...DEFAULT_FLAGS }
  try {
    const parsed = JSON.parse(row.value) as Partial<DemoFlags>
    return { ...DEFAULT_FLAGS, ...parsed }
  } catch {
    return { ...DEFAULT_FLAGS }
  }
}

export function writeFlags(db: DatabaseSync, flags: Partial<DemoFlags>): DemoFlags {
  const next = { ...readFlags(db), ...flags }
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    SETTINGS_KEY,
    JSON.stringify(next),
  )
  return next
}
