// 列表全量采集（虚拟滚动）：
// 页面一次只渲染视口内的行，所以采集端按滚动位置覆盖整个列表高度，每个位置只读真正可见的行。
// 行节点会被复用 —— 一律按订单号去重，同一订单号只记录第一次读到的滚动位置。
// 完成条件：页面提示「已滚动到底部」 + 本批快照内的订单数 = 筛选总数。
import type { Page } from 'playwright'
import { assertFixedSort, detectAuthState, isListAtEnd, readListState, scrollListTo, type ListRow } from './dom.js'
import { LoginExpiredError, type Credentials } from './session.js'

export interface BatchSnapshot {
  /** 本批固定的站点数据版本 */
  dataVersion: string
  /** 筛选范围内应采集的订单数 */
  expectedCount: number
  /** 本批快照时刻：placedAtMs 大于该值的订单属于快照后新建，不纳入本批 */
  snapshotMaxPlacedAtMs: number
}

export interface ScreenProgress {
  collected: number
  expected: number
  scrollTop: number
  screens: number
  /** 本屏新读到的行，调用方据此增量落库 */
  newRows: ListRow[]
  scrollTopFor: Map<string, number>
}

export interface CollectListOptions {
  credentials: Credentials
  reloginPath: string
  resumeFromScrollTop?: number
  alreadyCollected?: Set<string>
  onScreen?: (p: ScreenProgress) => void | Promise<void>
}

export interface CollectListResult {
  rows: Map<string, ListRow>
  /** 每张订单第一次被看到时的滚动位置 */
  scrollTopFor: Map<string, number>
  collectedCount: number
  pageTotalCount: number
  dataVersion: string
  /** 采集过程中页面数据版本是否已经前进（快照后新建了订单） */
  dataVersionChanged: boolean
  sortLabel: string
  screens: number
  reachedEnd: boolean
  excludedNewOrders: string[]
  duplicateReads: number
  lastScrollTop: number
}

export async function collectList(page: Page, snapshot: BatchSnapshot, opts: CollectListOptions): Promise<CollectListResult> {
  await assertFixedSort(page)
  const state0 = await readListState(page)
  if (state0.totalCount === null) throw new Error('页面上读不到「筛选范围内共 N 笔订单」')

  const rows = new Map<string, ListRow>()
  const scrollTopFor = new Map<string, number>()
  const excluded = new Set<string>()
  const visited = new Set<number>()
  let duplicateReads = 0
  let screens = 0
  let pageTotalCount = state0.totalCount
  let sortLabel = state0.sortLabel
  let dataVersionSeen = state0.dataVersion
  let versionChangedDuringRun = false

  if (opts.alreadyCollected) {
    for (const no of opts.alreadyCollected) rows.set(no, null as unknown as ListRow)
  }

  const collectedInSnapshot = (): number => {
    let n = 0
    for (const [no] of rows) if (!excluded.has(no)) n += 1
    return n
  }

  const readScreen = async (y: number): Promise<void> => {
    const applied = await scrollListTo(page, y)
    // 会话可能在滚动过程中过期：页面会变成「登录已过期」，此时必须立刻停下列表采集，
    // 已读的行已由 onScreen 逐屏落库，下次运行从保存的滚动位置继续。
    if ((await detectAuthState(page)) !== 'ok') throw new LoginExpiredError('采集列表过程中登录已过期，采集已暂停')
    if (visited.has(applied)) return
    screens += 1
    const state = await readListState(page)
    visited.add(applied)
    if (state.dataVersion) dataVersionSeen = state.dataVersion
    if (dataVersionSeen && snapshot.dataVersion && dataVersionSeen !== snapshot.dataVersion) versionChangedDuringRun = true
    if (state.totalCount !== null) pageTotalCount = state.totalCount
    sortLabel = state.sortLabel || sortLabel

    const newRows: ListRow[] = []
    for (const row of state.rows) {
      if (row.placedAtMs > snapshot.snapshotMaxPlacedAtMs) {
        excluded.add(row.orderNo)
        continue
      }
      if (rows.has(row.orderNo)) {
        duplicateReads += 1
        continue
      }
      rows.set(row.orderNo, row)
      scrollTopFor.set(row.orderNo, applied)
      newRows.push(row)
    }
    await opts.onScreen?.({
      collected: collectedInSnapshot(),
      expected: snapshot.expectedCount,
      scrollTop: applied,
      screens,
      newRows,
      scrollTopFor,
    })
  }

  /** 从 start 向下扫到底，再回绕覆盖 start 之前的部分，确保每个滚动位置至少被读一次。 */
  const sweep = async (start: number): Promise<void> => {
    const st = await readListState(page)
    const maxScroll = Math.max(0, st.scrollHeight - st.clientHeight)
    const step = Math.max(1, Math.floor((st.clientHeight || 560) * 0.6))
    const cap = Math.ceil(maxScroll / step) + 40
    let used = 0
    for (let y = Math.min(start, maxScroll); y <= maxScroll && used < cap; y += step, used++) {
      await readScreen(Math.min(y, maxScroll))
    }
    await readScreen(maxScroll)
    for (let y = Math.min(start, maxScroll) - step; y >= 0 && used < cap * 2; y -= step, used++) {
      await readScreen(y)
    }
    await readScreen(0)
  }

  await sweep(opts.resumeFromScrollTop ?? 0)

  // 确认到底提示（页面渲染「已滚动到底部」才能算完成）
  let reachedEnd = false
  for (let i = 0; i < 3 && !reachedEnd; i++) {
    const st = await readListState(page)
    await scrollListTo(page, Math.max(0, st.scrollHeight - st.clientHeight))
    reachedEnd = await isListAtEnd(page)
    if (!reachedEnd) await page.waitForTimeout(150)
  }

  return {
    rows,
    scrollTopFor,
    collectedCount: collectedInSnapshot(),
    pageTotalCount,
    dataVersion: dataVersionSeen,
    dataVersionChanged: versionChangedDuringRun,
    sortLabel,
    screens,
    reachedEnd,
    excludedNewOrders: [...excluded],
    duplicateReads,
    lastScrollTop: (await readListState(page)).scrollTop,
  }
}
