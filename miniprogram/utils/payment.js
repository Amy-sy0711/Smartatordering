/** 支付分流：前端只按 payMode 渲染，不重复写两套流程 */
const api = require('./api')

const FALLBACK_SETTINGS = {
  payMode: 'transfer',
  payModeLabel: '群转账 / 线下收款',
  transfer: {
    qrImageUrl: '',
    payeeName: '',
    tipText: '转账后请点「我已转账」，商家确认收款后开始备餐'
  },
  usable: true,
  unusableReason: '',
  jsapiConfigured: false,
  degraded: true
}

let cache = null

/** 读取云端支付配置；失败时回落到 transfer，页面照常渲染不白屏 */
function loadSettings(force) {
  if (cache && !force) return Promise.resolve(cache)
  return api
    .call('settings.payment')
    .then((data) => {
      cache = Object.assign({}, FALLBACK_SETTINGS, data, { degraded: false })
      return cache
    })
    .catch(() => {
      cache = Object.assign({}, FALLBACK_SETTINGS)
      return cache
    })
}

function getCached() {
  return cache || Object.assign({}, FALLBACK_SETTINGS)
}

function clearCache() {
  cache = null
}

/** 结算页按钮文案 */
function submitLabel(settings) {
  const mode = (settings && settings.payMode) || 'transfer'
  if (mode === 'jsapi') return '提交订单并支付'
  if (mode === 'mock') return '提交订单（模拟支付）'
  return '提交订单，稍后转账'
}

/** 结算页支付方式提示 */
function modeHint(settings) {
  const mode = (settings && settings.payMode) || 'transfer'
  if (mode === 'jsapi') {
    return (settings && settings.usable === false)
      ? (settings.unusableReason || '微信支付暂不可用，请联系商家')
      : '下单后在小程序内直接完成微信支付'
  }
  if (mode === 'mock') return '当前为开发调试模式：下单后直接模拟支付成功'
  return '下单后向商家转账，转账完成点「我已转账」，商家确认后开始备餐'
}

/** 顾客：我已转账 */
function markTransferred(orderId, note) {
  return api.call('order.markTransferred', { orderId, note: note || '' })
}

/** 通过支付云函数完成 mock / jsapi 支付 */
function payViaGateway(orderId, mode) {
  const action = mode === 'mock' ? 'mockPay' : 'jsapiPay'
  return api.callPayment(action, { orderId }).then((data) => {
    if (!data || data.paid) return data || { paid: true }
    if (mode !== 'jsapi') return data
    return requestPayment(data.payParams, orderId)
  })
}

function requestPayment(payParams, orderId) {
  return new Promise((resolve, reject) => {
    if (!payParams || !payParams.package) {
      const err = new Error('微信支付参数缺失，请稍后重试')
      err.code = 'PAY_PARAMS_INVALID'
      reject(err)
      return
    }
    wx.requestPayment({
      timeStamp: payParams.timeStamp,
      nonceStr: payParams.nonceStr,
      package: payParams.package,
      signType: payParams.signType || 'MD5',
      paySign: payParams.paySign,
      success() {
        resolve({ mode: 'jsapi', paid: true, orderId })
      },
      fail(res) {
        const isCancel = /cancel/i.test((res && res.errMsg) || '')
        const err = new Error(isCancel ? '已取消支付' : ((res && res.errMsg) || '支付失败'))
        err.code = isCancel ? 'PAY_CANCELED' : 'PAY_FAILED'
        reject(err)
      }
    })
  })
}

/** 按配置分流支付动作 */
function pay(orderId, settings) {
  const mode = (settings && settings.payMode) || 'transfer'
  if (mode === 'transfer') return markTransferred(orderId)
  return payViaGateway(orderId, mode)
}

module.exports = {
  FALLBACK_SETTINGS,
  loadSettings,
  getCached,
  clearCache,
  submitLabel,
  modeHint,
  markTransferred,
  payViaGateway,
  pay
}
