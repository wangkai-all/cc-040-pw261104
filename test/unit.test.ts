// 单元测试：演示数据确定性、金额解析、明细核对规则、排序口径。
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateDemoData } from '../src/shared/demoData.ts'
import { parseCount, parseMoneyToCents, centsToPlain, formatCents } from '../src/shared/money.ts'
import { validateDetail, type ScrapedDetail } from '../src/shared/validate.ts'
import { compareOrders, sortOrders } from '../src/shared/orderSort.ts'
import { batchIdentity } from '../src/server/batches.ts'
import { filterOrders } from '../src/server/site.ts'
import type { DemoOrder } from '../src/shared/types.ts'

const underTest = generateDemoData({ seed: 20261113, count: 40, startDate: '2026-08-01', days: 10 })
const orders: DemoOrder[] = underTest.orders

function scrapedFrom(o: DemoOrder): ScrapedDetail {
  return {
    orderNo: o.orderNo,
    status: o.status,
    buyer: o.buyer,
    placedAt: o.placedAt,
    totalAmountText: `¥${o.totalAmount.toFixed(2)}`,
    itemCountText: `${o.lines.length} 项`,
    lines: o.lines.map((l) => ({
      lineNo: l.lineNo,
      sku: l.sku,
      name: l.name,
      unitPriceText: `¥${l.unitPrice.toFixed(2)}`,
      quantityText: String(l.quantity),
      amountText: `¥${l.amount.toFixed(2)}`,
    })),
  }
}

test('演示数据是确定性的：同 seed 同参数生成完全一致的数据与版本号', () => {
  const a = generateDemoData({ seed: 7, count: 25, startDate: '2026-01-01', days: 5 })
  const b = generateDemoData({ seed: 7, count: 25, startDate: '2026-01-01', days: 5 })
  assert.deepEqual(a, b)
  const c = generateDemoData({ seed: 8, count: 25, startDate: '2026-01-01', days: 5 })
  assert.notDeepEqual(a.orders, c.orders)
  assert.equal(a.dataVersion, 'seed-7@2026-01-01+5d/25')
})

test('演示订单号唯一、排序固定为「下单时间倒序、订单号倒序」', () => {
  const nos = new Set(orders.map((o) => o.orderNo))
  assert.equal(nos.size, orders.length)
  const sorted = sortOrders(orders)
  assert.deepEqual(sorted.map((o) => o.orderNo), orders.map((o) => o.orderNo))
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!
    const cur = sorted[i]!
    assert.ok(prev.placedAtMs >= cur.placedAtMs, '下单时间必须倒序')
    if (prev.placedAtMs === cur.placedAtMs) assert.ok(prev.orderNo >= cur.orderNo, '同时间按下单号倒序')
  }
  // 每张订单行金额合计等于总额（数据本身自洽）
  for (const o of orders) {
    const sum = o.lines.reduce((s, l) => s + Math.round(l.amount * 100), 0)
    assert.equal(sum, Math.round(o.totalAmount * 100), `${o.orderNo} 行合计应等于总额`)
    for (const l of o.lines) {
      assert.equal(Math.round(l.unitPrice * 100) * l.quantity, Math.round(l.amount * 100))
    }
  }
})

test('日期筛选边界：from/to 都包含当天，空条件表示全部', () => {
  assert.equal(filterOrders(orders, '', '').length, orders.length)
  const days = [...new Set(orders.map((o) => o.orderDate))].sort()
  const mid = days[Math.floor(days.length / 2)]!
  const onlyMid = filterOrders(orders, mid, mid)
  assert.ok(onlyMid.length > 0)
  assert.ok(onlyMid.every((o) => o.orderDate === mid))
  const fromFirst = filterOrders(orders, days[0]!, '')
  assert.equal(fromFirst.length, orders.length)
  const uptoMid = filterOrders(orders, '', mid)
  assert.ok(uptoMid.every((o) => o.orderDate <= mid))
})

test('金额解析：整数分运算、可带货币符号/千分位/小数尾零', () => {
  assert.equal(parseMoneyToCents('¥1,899.00'), 189900)
  assert.equal(parseMoneyToCents('¥39.9'), 3990)
  assert.equal(parseMoneyToCents('39.90'), 3990)
  assert.equal(parseMoneyToCents('0'), 0)
  assert.equal(parseMoneyToCents('￥ 12 元'), 1200)
  assert.equal(parseMoneyToCents(''), null)
  assert.equal(parseMoneyToCents('¥12.345'), null)
  assert.equal(parseMoneyToCents('abc'), null)
  assert.equal(centsToPlain(1200), '12.00')
  assert.equal(centsToPlain(5), '0.05')
  assert.equal(formatCents(123456), '¥1,234.56')
  assert.equal(parseCount('共 3 项'), 3)
  assert.equal(parseCount('3 行'), 3)
  assert.equal(parseCount('无'), null)
})

test('明细核对：完全一致时全部通过且无异常', () => {
  for (const o of orders) {
    const v = validateDetail(scrapedFrom(o), {
      orderNo: o.orderNo,
      buyer: o.buyer,
      placedAt: o.placedAt,
      totalText: `¥${o.totalAmount.toFixed(2)}`,
      itemCountText: `${o.lines.length} 项`,
    })
    assert.equal(v.orderNoOk, true)
    assert.equal(v.itemCountOk, true)
    assert.equal(v.lineMathOk, true)
    assert.equal(v.totalOk, true)
    assert.deepEqual(v.issues, [])
  }
})

test('明细核对：订单号不一致被记为错误', () => {
  const o = orders[0]!
  const s = scrapedFrom(o)
  s.orderNo = 'SO-OTHER'
  const v = validateDetail(s, {
    orderNo: o.orderNo, buyer: o.buyer, placedAt: o.placedAt, totalText: `¥${o.totalAmount.toFixed(2)}`, itemCountText: `${o.lines.length} 项`,
  })
  assert.equal(v.orderNoOk, false)
  assert.ok(v.issues.some((i) => i.code === 'ORDER_NO_MISMATCH' && i.severity === 'error'))
})

test('明细核对：行数少于页面标注项数被记为错误', () => {
  const o = orders.find((x) => x.lines.length >= 2)!
  const s = scrapedFrom(o)
  s.lines = s.lines.slice(0, -1)
  const v = validateDetail(s, {
    orderNo: o.orderNo, buyer: o.buyer, placedAt: o.placedAt, totalText: `¥${o.totalAmount.toFixed(2)}`, itemCountText: `${o.lines.length} 项`,
  })
  assert.equal(v.itemCountOk, false)
  assert.ok(v.issues.some((i) => i.code === 'ITEM_COUNT_MISMATCH'))
})

test('明细核对：单价×数量 != 行金额被记为错误', () => {
  const o = orders[0]!
  const s = scrapedFrom(o)
  const line = s.lines[0]!
  line.amountText = '¥0.01'
  const v = validateDetail(s, {
    orderNo: o.orderNo, buyer: o.buyer, placedAt: o.placedAt, totalText: `¥${o.totalAmount.toFixed(2)}`, itemCountText: `${o.lines.length} 项`,
  })
  assert.equal(v.lineMathOk, false)
  assert.equal(v.totalOk, false)
  assert.ok(v.issues.some((i) => i.code === 'LINE_AMOUNT_MISMATCH'))
})

test('明细核对：行合计与订单总额不一致被记为错误（含跨页面总额不一致）', () => {
  const o = orders[0]!
  const s = scrapedFrom(o)
  const add = Math.round(o.totalAmount * 100) + 100
  s.totalAmountText = `¥${(add / 100).toFixed(2)}`
  const v = validateDetail(s, {
    orderNo: o.orderNo, buyer: o.buyer, placedAt: o.placedAt, totalText: `¥${(add / 100).toFixed(2)}`, itemCountText: `${o.lines.length} 项`,
  })
  assert.equal(v.totalOk, false)
  assert.ok(v.issues.some((i) => i.code === 'TOTAL_MISMATCH'))

  const s2 = scrapedFrom(o)
  const cross = Math.round(o.totalAmount * 100) + 500
  s2.totalAmountText = `¥${(cross / 100).toFixed(2)}`
  const v2 = validateDetail(s2, {
    orderNo: o.orderNo, buyer: o.buyer, placedAt: o.placedAt, totalText: `¥${o.totalAmount.toFixed(2)}`, itemCountText: `${o.lines.length} 项`,
  })
  // 明细总额变了但行金额没变：行合计 != 明细总额，且与列表总额不一致
  assert.equal(v2.totalOk, false)
  assert.ok(v2.issues.some((i) => i.code === 'TOTAL_CROSS_MISMATCH'))
})

test('明细核对：无法解析的金额被记为错误而不是当作 0', () => {
  const o = orders[0]!
  const s = scrapedFrom(o)
  s.lines[0]!.unitPriceText = '免费'
  const v = validateDetail(s, {
    orderNo: o.orderNo, buyer: o.buyer, placedAt: o.placedAt, totalText: `¥${o.totalAmount.toFixed(2)}`, itemCountText: `${o.lines.length} 项`,
  })
  assert.equal(v.lineMathOk, false)
  assert.ok(v.issues.some((i) => i.code === 'LINE_UNPARSEABLE'))
})

test('明细核对：买家/下单时间不一致只记警告，不影响通过', () => {
  const o = orders[0]!
  const s = scrapedFrom(o)
  s.buyer = '另一位买家'
  s.placedAt = '2000-01-01 00:00:00'
  const v = validateDetail(s, {
    orderNo: o.orderNo, buyer: o.buyer, placedAt: o.placedAt, totalText: `¥${o.totalAmount.toFixed(2)}`, itemCountText: `${o.lines.length} 项`,
  })
  assert.equal(v.orderNoOk && v.itemCountOk && v.lineMathOk && v.totalOk, true)
  assert.ok(v.issues.every((i) => i.severity === 'warning'))
  assert.ok(v.issues.some((i) => i.code === 'BUYER_MISMATCH'))
  assert.ok(v.issues.some((i) => i.code === 'PLACED_AT_MISMATCH'))
})

test('排序比较器稳定：时间倒序 + 订单号倒序兜底', () => {
  const cmp = compareOrders({ orderNo: 'A', placedAtMs: 1 }, { orderNo: 'A', placedAtMs: 1 })
  assert.equal(cmp, 0)
  assert.ok(compareOrders({ orderNo: 'A', placedAtMs: 2 }, { orderNo: 'B', placedAtMs: 1 }) < 0)
  assert.ok(compareOrders({ orderNo: 'B', placedAtMs: 1 }, { orderNo: 'A', placedAtMs: 1 }) < 0)
})

test('批次标识只由站点与筛选范围决定，同一筛选范围可复用', () => {
  const id1 = batchIdentity({ siteUrl: 'http://localhost:4310', filterFrom: '2026-08-01', filterTo: '2026-08-10' })
  const id2 = batchIdentity({ siteUrl: 'http://localhost:4310', filterFrom: '2026-08-01', filterTo: '2026-08-10' })
  assert.equal(id1, id2)
  const id3 = batchIdentity({ siteUrl: 'http://localhost:4310', filterFrom: '2026-08-02', filterTo: '2026-08-10' })
  assert.notEqual(id1, id3)
  assert.match(id1, /^2026-08-01~2026-08-10-[0-9a-f]{10}$/)
})
