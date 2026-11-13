/** 金额工具：内部一律用「分」整数运算，避免浮点误差。 */

export function parseMoneyToCents(text: string): number | null {
  const cleaned = text.replace(/[¥￥元,，\s]/g, '')
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null
  return Math.round(Number(cleaned) * 100)
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.round(cents))
  const yuan = Math.floor(abs / 100)
  const fen = String(abs % 100).padStart(2, '0')
  return `${sign}¥${yuan.toLocaleString('en-US')}.${fen}`
}

export function centsToPlain(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.round(cents))
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

export function money(n: number): string {
  return formatCents(Math.round(n * 100))
}

/** 解析「共 3 项」「3 项」「3 行」中的数量。 */
export function parseCount(text: string): number | null {
  const m = text.match(/-?\d+/)
  if (!m) return null
  return Number(m[0])
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}
