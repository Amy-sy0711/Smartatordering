'use strict'

/**
 * 多租户标识生成规则（纯逻辑，可离线单测）。
 * 默认商家沿用旧文档 ID，保证老数据迁移后仍可命中；其他商家统一加 merchantId 前缀。
 */

const DEFAULT_MERCHANT_ID = 'merchant_001'

function normalizeMerchantId(raw) {
  const value = String(raw === undefined || raw === null ? '' : raw).trim()
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : ''
}

function merchantIdOf(raw) {
  return normalizeMerchantId(raw) || DEFAULT_MERCHANT_ID
}

function compactDateKey(dateKey) {
  return String(dateKey || '').replace(/-/g, '')
}

function menuIdOf(dateKey, merchantId) {
  const compact = compactDateKey(dateKey)
  const mid = merchantIdOf(merchantId)
  return mid === DEFAULT_MERCHANT_ID ? 'm_' + compact : 'm_' + mid + '_' + compact
}

function counterIdOf(dateKey, merchantId) {
  const compact = compactDateKey(dateKey)
  const mid = merchantIdOf(merchantId)
  return mid === DEFAULT_MERCHANT_ID ? 'seq_' + compact : 'seq_' + mid + '_' + compact
}

function paymentDocId(merchantId) {
  const mid = merchantIdOf(merchantId)
  return mid === DEFAULT_MERCHANT_ID ? 'payment' : 'payment_' + mid
}

module.exports = {
  DEFAULT_MERCHANT_ID,
  normalizeMerchantId,
  merchantIdOf,
  compactDateKey,
  menuIdOf,
  counterIdOf,
  paymentDocId
}
