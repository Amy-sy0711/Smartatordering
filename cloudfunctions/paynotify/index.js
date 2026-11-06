'use strict'

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const ORDERS = 'orders'
const PAYMENT_RECORDS = 'payment_records'

/**
 * 微信支付结果回调（cloudPay 统一由云开发托管签名校验，这里只处理业务）。
 * 必须在 cloudfunctions/pay/index.js 的 unifiedOrder 里把 functionName 指向本函数名：paynotify。
 * 返回 { errcode: 0 } 表示处理成功，微信支付不再重试。
 */
exports.main = async (event) => {
  const body = event || {}
  const returnCode = body.returnCode || body.return_code
  const resultCode = body.resultCode || body.result_code
  const outTradeNo = String(body.outTradeNo || body.out_trade_no || '')
  const transactionId = String(body.transactionId || body.transaction_id || '')
  const totalFee = Number(body.totalFee === undefined ? body.total_fee : body.totalFee)

  if (returnCode !== 'SUCCESS' || resultCode !== 'SUCCESS') {
    console.warn('[paynotify] 支付未成功', returnCode, resultCode)
    return { errcode: 1, errmsg: 'FAIL' }
  }

  let order = null
  try {
    const res = await db.collection(ORDERS).doc(outTradeNo).get()
    order = (res && res.data) || null
  } catch (err) {
    order = null
  }
  if (!order) {
    console.error('[paynotify] 订单不存在', outTradeNo)
    return { errcode: 1, errmsg: 'ORDER_NOT_FOUND' }
  }

  // 金额校验：防止篡改（单位分）
  if (!Number.isInteger(totalFee) || totalFee !== order.totalCents) {
    console.error('[paynotify] 金额不匹配', outTradeNo, totalFee, order.totalCents)
    return { errcode: 1, errmsg: 'AMOUNT_MISMATCH' }
  }

  if (order.status !== 'pending_pay') {
    // 幂等：已处理过直接返回成功
    return { errcode: 0, errmsg: 'SUCCESS' }
  }

  const now = new Date()
  const res = await db
    .collection(ORDERS)
    .where({ _id: outTradeNo, status: 'pending_pay', merchantId: order.merchantId })
    .update({
      data: {
        status: 'paid',
        payChannel: 'jsapi',
        transactionId,
        paidAt: now,
        updatedAt: now,
        statusHistory: _.push({ status: 'paid', at: now, by: 'jsapi' })
      }
    })
  if (!res.stats || !res.stats.updated) {
    return { errcode: 0, errmsg: 'SUCCESS' }
  }

  // 落一条收款记录（对账用），重复回调时忽略主键冲突
  try {
    await db.collection(PAYMENT_RECORDS).add({
      data: {
        _id: 'pr_' + outTradeNo,
        orderId: outTradeNo,
        orderNo: order.orderNo,
        merchantId: order.merchantId,
        date: order.date,
        amountCents: order.totalCents,
        channel: 'jsapi',
        operatorOpenid: 'system:paynotify',
        at: now,
        note: '微信支付回调 transactionId=' + transactionId,
        createdAt: now
      }
    })
  } catch (err) {
    console.warn('[paynotify] 收款记录已存在，忽略')
  }

  return { errcode: 0, errmsg: 'SUCCESS' }
}
