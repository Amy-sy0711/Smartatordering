/* 登录按钮状态机：idle → loading → success/error → idle（可被单元测试直接 require） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.AdminLoginState = factory()
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var STATES = ['idle', 'loading', 'success', 'error']

  function create(onChange) {
    var state = 'idle'
    var history = []
    var lastResult = ''

    function apply(next) {
      if (STATES.indexOf(next) < 0) throw new Error('未知的登录状态：' + next)
      state = next
      history.push(next)
      if (typeof onChange === 'function') onChange(next, lastResult)
      return state
    }

    return {
      getState: function () {
        return state
      },
      getHistory: function () {
        return history.slice()
      },
      getLastResult: function () {
        return lastResult
      },
      isBusy: function () {
        return state === 'loading'
      },
      /** 点击开始：重复点击返回 false，防止并发登录 */
      start: function () {
        if (state === 'loading') return false
        apply('loading')
        return true
      },
      /** 成功：loading → success → idle */
      succeed: function () {
        if (state !== 'loading') return false
        lastResult = 'success'
        apply('success')
        apply('idle')
        return true
      },
      /** 失败：loading → error → idle */
      fail: function () {
        if (state !== 'loading') return false
        lastResult = 'error'
        apply('error')
        apply('idle')
        return true
      },
      /** 非 loading 状态下强制复位 */
      reset: function () {
        if (state === 'loading') return false
        apply('idle')
        return true
      }
    }
  }

  return { create: create, STATES: STATES }
})
