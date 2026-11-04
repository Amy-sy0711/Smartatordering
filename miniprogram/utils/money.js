/** 金额工具：一律以「分」为单位的整数，展示时才转成元，不产生浮点运算 */

function assertCents(value) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new Error('金额必须是整数分：' + String(value))
  }
  return value
}

function formatCents(cents) {
  const n = assertCents(cents)
  const abs = Math.abs(n)
  const yuan = (abs - (abs % 100)) / 100
  const fen = abs % 100
  return (n < 0 ? '-' : '') + String(yuan) + '.' + (fen < 10 ? '0' + fen : String(fen))
}

function formatDelta(deltaCents) {
  const n = assertCents(deltaCents)
  if (n === 0) return ''
  return (n > 0 ? '+' : '-') + formatCents(Math.abs(n))
}

/** '12.5' -> 1250；非法输入返回 null */
function parseYuanToCents(input) {
  if (input === null || input === undefined) return null
  const s = String(input).trim()
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(s)) return null
  const parts = s.split('.')
  const yuanPart = Number(parts[0])
  const fenPart = Number(((parts[1] || '') + '00').slice(0, 2))
  if (!Number.isInteger(yuanPart) || !Number.isInteger(fenPart)) return null
  return yuanPart * 100 + fenPart
}

function sumCents(list) {
  let total = 0
  for (const n of list) total += assertCents(n)
  return total
}

module.exports = { assertCents, formatCents, formatDelta, parseYuanToCents, sumCents }
