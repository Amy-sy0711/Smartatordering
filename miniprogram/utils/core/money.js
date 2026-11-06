'use strict'

const { fail } = require('./errors')

/** 金额必须是以「分」为单位的整数 */
function assertCents(value, field) {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail('MONEY_NOT_INTEGER', `${field || '金额'}必须是以「分」为单位的整数`)
  }
  return value
}

function add(a, b) {
  assertCents(a, '金额')
  assertCents(b, '金额')
  return a + b
}

function multiply(unitCents, qty) {
  assertCents(unitCents, '单价')
  if (!Number.isInteger(qty) || qty < 0) fail('QTY_INVALID', '数量必须为非负整数')
  return unitCents * qty
}

function sum(list) {
  let total = 0
  for (const n of list) total = add(total, n)
  return total
}

/** 分 -> '12.50'，全程整数运算，不产生浮点 */
function formatCents(cents) {
  const n = assertCents(cents, '金额')
  const abs = Math.abs(n)
  const yuan = (abs - (abs % 100)) / 100
  const fen = abs % 100
  return (n < 0 ? '-' : '') + String(yuan) + '.' + (fen < 10 ? '0' + fen : String(fen))
}

/**
 * '12.5' -> 1250；非法输入返回 null（纯字符串整数运算，不经过浮点解析）
 */
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

module.exports = { assertCents, add, multiply, sum, formatCents, parseYuanToCents }
