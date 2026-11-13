// 站点与采集端共享的页面契约：排序口径、虚拟滚动尺寸、每页 boot 数据。
// 采集端只依赖页面渲染出来的内容（data-* 属性、文本），不读取这里的 boot 或 /api。
export const SITE_SORT = {
  field: 'placedAt',
  direction: 'desc',
} as const

/** 列表行高（虚拟滚动用），采集端据此把行索引换算成滚动位置 */
export const LIST_ROW_HEIGHT = 56
/** 虚拟滚动视口高度 */
export const LIST_VIEWPORT_HEIGHT = 560
/** 视口外额外渲染的行数（采集端按可见区域过滤，不读这些） */
export const LIST_OVERSCAN = 2

/** 站点固定排序的展示文案，页面上会直接渲染出来供采集端核对 */
export const SITE_SORT_LABEL = '下单时间倒序'

export interface BootOrderRow {
  orderNo: string
  placedAt: string
  placedAtMs: number
  buyer: string
  status: string
  itemCountText: string
  totalText: string
}

export interface BootOrderLine {
  lineNo: number
  sku: string
  name: string
  unitPriceText: string
  quantityText: string
  amountText: string
}

export interface BootFlags {
  detailDelayMs: number
  sessionExpiryMs: number
  autoLogout: boolean
}

export type SiteBoot =
  | { kind: 'login'; next: string; accounts: { username: string; password: string; displayName: string }[]; error?: string }
  | { kind: 'expired'; next: string; sessionNote: string }
  | {
      kind: 'orders'
      username: string
      from: string
      to: string
      sort: { field: string; direction: string; label: string }
      dataVersion: string
      totalCount: number
      dateRangeText: string
      sessionNote: string
      orders: BootOrderRow[]
    }
  | {
      kind: 'detail'
      username: string
      order: {
        orderNo: string
        placedAt: string
        buyer: string
        status: string
        totalText: string
        itemCountText: string
        lines: BootOrderLine[]
      }
      detailDelayMs: number
      from: string
      to: string
      backUrl: string
      sessionNote: string
    }
  | {
      kind: 'console'
      username: string
      flags: BootFlags
      dataVersion: string
      snapshotAt: string
      orderCount: number
    }

declare global {
  interface Window {
    __SITE_BOOT__?: SiteBoot
  }
}
