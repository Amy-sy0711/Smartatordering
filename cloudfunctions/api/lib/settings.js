'use strict'

const config = require('../config')
const { COLLECTIONS: COL } = require('../core/collections')
const paymode = require('../core/paymode')
const { fail } = require('../core/errors')
const tenant = require('../core/tenant')
const { getDocOrNull } = require('./db')

const PAYMENT_DOC_ID = 'payment'

/** 默认商家沿用旧文档 ID（兼容迁移）；其他商家使用 payment_<merchantId> */
function paymentDocId(merchantId) {
  return tenant.paymentDocId(merchantId)
}

/** 读取云端支付配置，缺失时回落到默认值（默认 transfer） */
async function getPaymentSettings(db, merchantId) {
  const doc = await getDocOrNull(db, COL.SETTINGS, paymentDocId(merchantId))
  return paymode.normalizePaymentSettings(doc)
}

/** 商家更新支付配置（payMode / 转账二维码 / 文案），按商家隔离 */
async function savePaymentSettings(db, input, openid, merchantId) {
  const patch = input || {}
  const mid = String(merchantId || config.DEFAULT_MERCHANT_ID)
  const docId = paymentDocId(mid)
  if (patch.payMode !== undefined && !paymode.isPayMode(patch.payMode)) {
    fail('PAY_MODE_INVALID', '支付方式只能是 transfer / jsapi / mock')
  }
  const existing = await getDocOrNull(db, COL.SETTINGS, docId)
  const mergedRaw = {
    payMode: patch.payMode !== undefined ? patch.payMode : existing && existing.payMode,
    transfer: Object.assign({}, (existing && existing.transfer) || {}, patch.transfer || {})
  }
  const normalized = paymode.normalizePaymentSettings(mergedRaw)
  const data = {
    merchantId: mid,
    payMode: normalized.payMode,
    transfer: normalized.transfer,
    updatedAt: new Date(),
    updatedBy: openid || '',
    createdAt: (existing && existing.createdAt) || new Date()
  }
  await db.collection(COL.SETTINGS).doc(docId).set({ data })
  return paymode.normalizePaymentSettings(data)
}

module.exports = { PAYMENT_DOC_ID, paymentDocId, getPaymentSettings, savePaymentSettings }
