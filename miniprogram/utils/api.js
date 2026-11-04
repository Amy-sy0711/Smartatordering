/** 云函数统一调用：入参 {action, payload}，出参 {code, data} */

function callFn(name, action, payload) {
  return wx.cloud
    .callFunction({ name, data: { action, payload: payload || {} } })
    .then((res) => {
      const result = res && res.result
      if (!result || typeof result.code === 'undefined') {
        const err = new Error('云函数返回格式异常')
        err.code = 'BAD_RESPONSE'
        throw err
      }
      if (result.code !== 0) {
        const err = new Error(result.message || String(result.code))
        err.code = result.code
        throw err
      }
      return result.data
    })
    .catch((err) => {
      if (err && err.code) throw err
      const wrapped = new Error((err && (err.errMsg || err.message)) || '网络异常，请稍后重试')
      wrapped.code = 'CALL_FAILED'
      throw wrapped
    })
}

function call(action, payload) {
  return callFn('api', action, payload)
}

function callPayment(action, payload) {
  return callFn('pay', action, payload)
}

function showError(err, title) {
  wx.showModal({
    title: title || '操作失败',
    content: (err && (err.message || err.errMsg)) || '请稍后重试',
    showCancel: false,
    confirmText: '知道了'
  })
}

module.exports = { call, callFn, callPayment, showError }
