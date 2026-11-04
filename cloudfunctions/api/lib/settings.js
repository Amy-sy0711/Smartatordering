'use strict'

const { COLLECTIONS: COL } = require('../core/collections')
const paymode = require('../core/paymode')
const { fail } = require('../core/errors')
const { getDocOrNull } = require('./db')

const PAYMENT_DOC_ID = 'payment'

/** 读取云端支付配置（settings/payment），缺失时回落到默认值（默认 transfer） */
async function getPaymentSettings(db) {
  const doc = await getDocOrNull(db, COL.SETTINGS, PAYMENT_DOC_ID)
  return paymode.normalizePaymentSettings(doc)
}

/** 商家更新支付配置（payMode / 转账二维码 / 文案） */
async function savePaymentSettings(db, input, openid) {
  const patch = input || {}
  if (patch.payMode !== undefined && !paymode.isPayMode(patch.payMode)) {
    fail('PAY_MODE_INVALID', '支付方式只能是 transfer / jsapi / mock')
  }
  const existing = await getDocOrNull(db, COL.SETTINGS, PAYMENT_DOC_ID)
  const mergedRaw = {
    payMode: patch.payMode !== undefined ? patch.payMode : existing && existing.payMode,
    transfer: Object.assign({}, (existing && existing.transfer) || {}, patch.transfer || {})
  }
  const normalized = paymode.normalizePaymentSettings(mergedRaw)
  const data = {
    payMode: normalized.payMode,
    transfer: normalized.transfer,
    updatedAt: new Date(),
    updatedBy: openid || '',
    createdAt: (existing && existing.createdAt) || new Date()
  }
  await db.collection(COL.SETTINGS).doc(PAYMENT_DOC_ID).set({ data })
  return paymode.normalizePaymentSettings(data)
}

module.exports = { PAYMENT_DOC_ID, getPaymentSettings, savePaymentSettings }
