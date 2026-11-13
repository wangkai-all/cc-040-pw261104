// 采集端本地排序：复刻站点固定排序口径（下单时间倒序，订单号倒序兜底），
// 以便按页面暴露的排序键计算订单在列表中的位置。
export interface OrderSortKey {
  orderNo: string
  placedAtMs: number
}

export function compareOrders(a: OrderSortKey, b: OrderSortKey): number {
  if (a.placedAtMs !== b.placedAtMs) return b.placedAtMs - a.placedAtMs
  return b.orderNo.localeCompare(a.orderNo)
}

export function sortOrders<T extends OrderSortKey>(orders: T[]): T[] {
  return [...orders].sort(compareOrders)
}
