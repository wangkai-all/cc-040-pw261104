export interface DemoOrderLine {
  lineNo: number
  sku: string
  name: string
  unitPrice: number
  quantity: number
  amount: number
}

export interface DemoOrder {
  orderNo: string
  orderDate: string
  /** 列表排序键：YYYY-MM-DD HH:mm:ss（站点固定排序字段） */
  placedAt: string
  placedAtMs: number
  buyer: string
  status: string
  totalAmount: number
  itemCount: number
  lines: DemoOrderLine[]
}
