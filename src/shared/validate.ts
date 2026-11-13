import { parseMoneyToCents, parseCount } from './money.js'

/** 明细页面上采集到的原始字段（全部来自可见文本） */
export interface ScrapedLine {
  lineNo: number
  sku: string
  name: string
  unitPriceText: string
  quantityText: string
  amountText: string
}

export interface ScrapedDetail {
  orderNo: string
  status: string
  buyer: string
  placedAt: string
  totalAmountText: string
  itemCountText: string
  lines: ScrapedLine[]
}

/** 列表行里能看到、需要与明细交叉核对的字段 */
export interface ExpectedFromList {
  orderNo: string
  buyer: string
  placedAt: string
  totalText: string
  itemCountText: string
}

export interface ValidationIssue {
  code: string
  message: string
  severity: 'error' | 'warning'
}

export interface DetailValidation {
  /** 订单号与列表中一致 */
  orderNoOk: boolean
  /** 明细行数 = 页面标注项数 = 列表行内项数 */
  itemCountOk: boolean
  /** 每行单价×数量 = 行金额 */
  lineMathOk: boolean
  /** 行金额合计 = 订单总额（且列表总额与明细总额一致） */
  totalOk: boolean
  issues: ValidationIssue[]
}

/**
 * 核对明细：
 * 1) 订单号与列表行一致；
 * 2) 明细行数与页面标注的项数、列表行标注的项数一致；
 * 3) 每行「单价 × 数量 = 行金额」；
 * 4) 行金额合计 = 明细页订单总额 = 列表页订单总额。
 */
export function validateDetail(scraped: ScrapedDetail, expected: ExpectedFromList): DetailValidation {
  const issues: ValidationIssue[] = []

  const orderNoOk = scraped.orderNo.trim() === expected.orderNo.trim()
  if (!orderNoOk) {
    issues.push({
      code: 'ORDER_NO_MISMATCH',
      severity: 'error',
      message: `明细页订单号为「${scraped.orderNo}」，列表行订单号为「${expected.orderNo}」`,
    })
  }

  const detailPageCount = parseCount(scraped.itemCountText)
  const listRowCount = parseCount(expected.itemCountText)
  const itemCountOk =
    detailPageCount !== null && detailPageCount === scraped.lines.length && listRowCount === scraped.lines.length
  if (!itemCountOk) {
    issues.push({
      code: 'ITEM_COUNT_MISMATCH',
      severity: 'error',
      message: `明细实际 ${scraped.lines.length} 行，明细页标注「${scraped.itemCountText}」，列表行标注「${expected.itemCountText}」`,
    })
  }

  const detailTotalCents = parseMoneyToCents(scraped.totalAmountText)
  const listTotalCents = parseMoneyToCents(expected.totalText)
  if (detailTotalCents === null) {
    issues.push({ code: 'TOTAL_UNPARSEABLE', severity: 'error', message: `无法解析明细页订单总额「${scraped.totalAmountText}」` })
  }
  if (listTotalCents === null) {
    issues.push({ code: 'LIST_TOTAL_UNPARSEABLE', severity: 'error', message: `无法解析列表页订单总额「${expected.totalText}」` })
  }

  const totalCents = detailTotalCents ?? listTotalCents
  let lineMathOk = true
  let sumCents = 0
  for (const line of scraped.lines) {
    const unit = parseMoneyToCents(line.unitPriceText)
    const qty = parseCount(line.quantityText)
    const amount = parseMoneyToCents(line.amountText)
    if (unit === null || qty === null || amount === null) {
      lineMathOk = false
      issues.push({
        code: 'LINE_UNPARSEABLE',
        severity: 'error',
        message: `第 ${line.lineNo} 行数据无法解析：单价「${line.unitPriceText}」数量「${line.quantityText}」行金额「${line.amountText}」`,
      })
      continue
    }
    if (unit * qty !== amount) {
      lineMathOk = false
      issues.push({
        code: 'LINE_AMOUNT_MISMATCH',
        severity: 'error',
        message: `第 ${line.lineNo} 行 ${line.sku}：单价 × 数量 = ${unit} × ${qty} = ${unit * qty} 分，页面行金额为 ${amount} 分`,
      })
    }
    sumCents += amount
  }

  let totalOk = false
  if (totalCents !== null && lineMathOk) {
    totalOk = sumCents === totalCents && listTotalCents === detailTotalCents
    if (sumCents !== totalCents) {
      issues.push({
        code: 'TOTAL_MISMATCH',
        severity: 'error',
        message: `明细行合计 ${sumCents} 分，订单总额 ${totalCents} 分，差额 ${sumCents - totalCents} 分`,
      })
    }
    if (listTotalCents !== null && detailTotalCents !== null && listTotalCents !== detailTotalCents) {
      issues.push({
        code: 'TOTAL_CROSS_MISMATCH',
        severity: 'error',
        message: `列表页总额「${expected.totalText}」与明细页总额「${scraped.totalAmountText}」不一致`,
      })
    }
  }

  // 买家/下单时间：列表与明细上的重复字段，用于交叉核对
  if (scraped.buyer.trim() !== expected.buyer.trim()) {
    issues.push({
      code: 'BUYER_MISMATCH',
      severity: 'warning',
      message: `列表买家「${expected.buyer}」与明细买家「${scraped.buyer}」不一致`,
    })
  }
  if (scraped.placedAt.trim() !== expected.placedAt.trim()) {
    issues.push({
      code: 'PLACED_AT_MISMATCH',
      severity: 'warning',
      message: `列表下单时间「${expected.placedAt}」与明细下单时间「${scraped.placedAt}」不一致`,
    })
  }

  return { orderNoOk, itemCountOk, lineMathOk, totalOk, issues }
}
