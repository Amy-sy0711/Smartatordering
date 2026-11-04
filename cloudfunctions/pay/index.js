'use strict'

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command
const config = require('./config')
const paymode = require('./core/paymode')
const { fail, isAppError } = require('./core/errors')

const COL = config.COLLECTIONS

function nonceStr() {
  return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
}

function mockTransactionId() {
  return 'MOCK' + Date.now() + Math.floor(Math.random() * 9000 + 1000)
}

async function readPaymentSettings() {
  let doc = null
  try {
    const res = await db.collection(COL.SETTINGS).doc('payment').get()
    doc = res && res.data
  } catch (err) {
    doc = null
  }
  return paymode.normalizePaymentSettings(doc)
}

async function loadOrder(orderId) {
  const id = String(orderId || '')
  if (!id) fail('ORDER_ID_REQUIRED', '缺少订单号')
  try {
    const res = await db.collection(COL.ORDERS).doc(id).get()
    return (res && res.data) || null
  } catch (err) {
    return null
  }
}

function ensurePayableOrder(order, openid) {
  if (!order) fail('ORDER_NOT_FOUND', '订单不存在')
  if (order.buyerOpenid !== openid) fail('FORBIDDEN', '只能支付自己的订单')
  if (order.status !== 'pending_pay') {
    fail('ORDER_NOT_PAYABLE', '订单当前状态不是「待付款」，无法支付')
  }
}

/* ------------------------------- mock ------------------------------- */
async function mockPay(order) {
  const now = new Date()
  const transactionId = mockTransactionId()
  const res = await db
    .collection(COL.ORDERS)
    .where({ _id: order._id, status: 'pending_pay' })
    .update({
      data: {
        status: 'paid',
        payChannel: paymode.PAY_MODES.MOCK,
        transactionId,
        paidAt: now,
        updatedAt: now,
        statusHistory: _.push({ status: 'paid', at: now, by: 'mock' })
      }
    })
  if (!res.stats || !res.stats.updated) fail('ORDER_NOT_PAYABLE', '订单已被支付或状态已变化')

  return {
    mode: paymode.PAY_MODES.MOCK,
    paid: true,
    orderId: order._id,
    status: 'paid',
    transactionId,
    totalCents: order.totalCents
  }
}

/* ------------------------------- jsapi ------------------------------ */
/**
 * 真实微信支付接入点（cloudPay JSAPI）。
 * 需要：云开发控制台完成微信支付商户配置 + config.js 里打开 ENABLED 并填 subMchId / envId。
 * 未配置时抛 WXPAY_NOT_CONFIGURED（前端弹窗提示），不会白屏。
 */
async function createJsapiPayment(order) {
  const wxpay = config.WXPAY
  const res = await cloud.cloudPay.unifiedOrder({
    body: (wxpay.BODY_PREFIX || '点餐') + '-' + order.orderNo,
    outTradeNo: order.orderNo, // 订单号即 outTradeNo，回调时用它定位订单
    spbillCreateIp: '127.0.0.1',
    subMchId: wxpay.SUB_MCH_ID,
    totalFee: order.totalCents, // 单位：分（整数）
    envId: wxpay.ENV_ID,
    functionName: 'paynotify',  // 支付结果回调云函数
    nonceStr: nonceStr(),
    tradeType: 'JSAPI'
  })

  if (!res || (res.returnCode && res.returnCode !== 'SUCCESS') || !res.payment) {
    fail('WXPAY_UNIFIED_ORDER_FAILED', (res && res.returnMsg) || '微信统一下单失败，请稍后重试')
  }

  const now = new Date()
  await db.collection(COL.ORDERS).doc(order._id).update({
    data: {
      payChannel: paymode.PAY_MODES.JSAPI,
      prepayRequestedAt: now,
      updatedAt: now
    }
  })

  // payment 交给前端 wx.requestPayment 使用
  return { mode: paymode.PAY_MODES.JSAPI, paid: false, orderId: order._id, payParams: res.payment }
}

async function jsapiPay(order) {
  return createJsapiPayment(order)
}

/* ------------------------------ 统一入口 ----------------------------- */
async function payOrder(action, openid, payload) {
  const settings = await readPaymentSettings()
  const branch = paymode.resolvePayBranch({
    payMode: settings.payMode,
    wxpayEnabled: config.WXPAY.ENABLED,
    subMchId: config.WXPAY.SUB_MCH_ID,
    envId: config.WXPAY.ENV_ID
  })

  if (settings.payMode === paymode.PAY_MODES.TRANSFER) {
    fail('PAY_USE_TRANSFER', '当前为群转账收款：请转账后点击「我已转账」')
  }

  const requested = action === 'mockPay' ? paymode.PAY_MODES.MOCK : paymode.PAY_MODES.JSAPI
  if (action !== 'pay' && requested !== settings.payMode) {
    fail('PAY_MODE_MISMATCH', `当前收款方式是「${paymode.PAY_MODE_LABELS[settings.payMode]}」，请刷新页面后重试`)
  }

  paymode.assertPayBranchUsable(branch)

  const order = await loadOrder(payload.orderId)
  ensurePayableOrder(order, openid)

  if (branch.mode === paymode.PAY_MODES.MOCK) return mockPay(order)
  return jsapiPay(order)
}

exports.main = async (event) => {
  const action = String((event && event.action) || 'pay')
  const payload = (event && event.payload) || {}
  const openid = cloud.getWXContext().OPENID || ''

  try {
    if (action === 'pay' || action === 'mockPay' || action === 'jsapiPay') {
      const data = await payOrder(action, openid, payload)
      return { code: 0, data }
    }
    return { code: 'UNKNOWN_ACTION', message: '未知的支付接口：' + action }
  } catch (err) {
    if (isAppError(err)) return { code: err.code, message: err.message }
    console.error('[pay] 支付失败', err)
    return { code: 'INTERNAL_ERROR', message: (err && err.message) || '支付服务异常，请稍后重试' }
  }
}
