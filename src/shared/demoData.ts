// 站点演示数据：确定性的订单与明细生成器。
// 每次启动按 seed 生成同一份版本，订单号连续且可预测，便于核对采集结果。
import type { DemoOrder, DemoOrderLine } from './types.js'

function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const PRODUCTS = [
  { sku: 'SKU-1001', name: '不锈钢保温杯 500ml', unitPrice: 129 },
  { sku: 'SKU-1002', name: '机械键盘 87 键', unitPrice: 459 },
  { sku: 'SKU-1003', name: '人体工学椅', unitPrice: 1899 },
  { sku: 'SKU-1004', name: 'Type-C 快充线 2m', unitPrice: 39.9 },
  { sku: 'SKU-1005', name: '降噪耳机', unitPrice: 999 },
  { sku: 'SKU-1006', name: '便携显示器 16 寸', unitPrice: 1599 },
  { sku: 'SKU-1007', name: '桌面升降台', unitPrice: 799 },
  { sku: 'SKU-1008', name: '笔记本内胆包', unitPrice: 89 },
  { sku: 'SKU-1009', name: '无线鼠标', unitPrice: 149 },
  { sku: 'SKU-1010', name: '4K 摄像头', unitPrice: 699 },
  { sku: 'SKU-1011', name: '桌面收纳盒', unitPrice: 59.9 },
  { sku: 'SKU-1012', name: 'USB 扩展坞', unitPrice: 329 },
] as const

const BUYERS = [
  '王小明', '李静', '陈志强', '赵敏', '周凯', '吴晓雯', '孙立', '郑楠',
  '冯雪', '何伟', '刘一诺', '黄婷', '马超', '徐子涵', '朱磊', '胡月',
] as const

const STATUSES: DemoOrder['status'][] = [
  '已付款', '已付款', '已付款', '已发货', '已发货', '已完成', '已完成', '待付款',
]

export interface SeedOptions {
  seed?: number
  /** 订单数量，默认 300 */
  count?: number
  /** 起始日期（本地时区 YYYY-MM-DD），订单按天均匀分布并逐个下单时间递增 */
  startDate?: string
  /** 需要的日期跨度（天），订单会分布在这段日期内 */
  days?: number
}

export interface SeedResult {
  orders: DemoOrder[]
  /** 站点数据版本号：由 seed 与订单边界推导，采集批次以此固定数据快照 */
  dataVersion: string
}

/** 将日期字符串解析为本地时区中午 12 点，避免夏令时/时区导致的跨日漂移。 */
export function dateAtNoon(date: string): Date {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y!, (m ?? 1) - 1, d ?? 1, 12, 0, 0, 0)
}

export function formatDay(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatTimestamp(d: Date): string {
  return `${formatDay(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export function generateDemoData(opts: SeedOptions = {}): SeedResult {
  const seed = opts.seed ?? 20261113
  const count = opts.count ?? 300
  const startDate = opts.startDate ?? '2026-08-01'
  const days = opts.days ?? 30
  const rand = mulberry32(seed)
  const start = dateAtNoon(startDate)

  const orders: DemoOrder[] = []
  for (let i = 0; i < count; i++) {
    // 均匀分布到 days 天内，再给同一时刻加一点秒级抖动，保证排序键唯一
    const dayOffset = Math.floor((i * days) / count)
    const placedAt = new Date(start.getTime())
    placedAt.setDate(placedAt.getDate() + dayOffset)
    const secondsInDay = 8 * 3600 + Math.floor(rand() * 10 * 3600)
    placedAt.setHours(0, 0, 0, 0)
    placedAt.setSeconds(secondsInDay)

    const lineCount = 1 + Math.floor(rand() * 3)
    const lines: DemoOrderLine[] = []
    for (let l = 0; l < lineCount; l++) {
      const p = PRODUCTS[Math.floor(rand() * PRODUCTS.length)]!
      const qty = 1 + Math.floor(rand() * 3)
      lines.push({
        lineNo: l + 1,
        sku: p.sku,
        name: p.name,
        unitPrice: p.unitPrice,
        quantity: qty,
        amount: round2(p.unitPrice * qty),
      })
    }
    const totalAmount = round2(lines.reduce((sum, l) => sum + l.amount, 0))
    const idx = i + 1
    orders.push({
      orderNo: `SO2026${String(seed).slice(-4)}${String(idx).padStart(5, '0')}`,
      orderDate: formatDay(placedAt),
      placedAt: formatTimestamp(placedAt),
      placedAtMs: placedAt.getTime(),
      buyer: BUYERS[Math.floor(rand() * BUYERS.length)]!,
      status: STATUSES[Math.floor(rand() * STATUSES.length)]!,
      totalAmount,
      itemCount: lines.length,
      lines,
    })
  }
  // 固定排序口径：下单时间倒序，订单号兜底保证稳定
  orders.sort((a, b) => b.placedAtMs - a.placedAtMs || b.orderNo.localeCompare(a.orderNo))
  return { orders, dataVersion: `seed-${seed}@${startDate}+${days}d/${count}` }
}
