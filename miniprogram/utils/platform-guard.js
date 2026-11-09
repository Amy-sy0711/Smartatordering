'use strict'

/**
 * 小程序内平台管理入口守卫（纯逻辑 + 轻量封装，可单测）。
 *
 * 与浏览器管理台（A 方案）完全解耦：
 *  - 不依赖浏览器匿名登录 / Web 安全域名
 *  - 用 wx.cloud.callFunction 带来的 openid 判定平台管理员
 *  - 未绑定时允许用管理员账号 + 密码绑定当前微信，绑定后才调用 adminApi
 */

const MENU_PATH = '/pages/menu/menu'

/** 这些错误说明「还没绑定 / 绑定失败」，页面应展示绑定表单而不是直接踢回首页 */
const BINDABLE_CODES = [
  'ADMIN_OPENID_NOT_BOUND',
  'INVALID_CREDENTIALS',
  'ADMINS_COLLECTION_MISSING',
  'ENV_MISSING'
]

function decidePlatformAccess(result) {
  const src = result || {}
  if (src.ok === true || src.bound === true) {
    return { allowed: true, needBind: false, code: 'OK', message: '', hint: '', admin: src.admin || null }
  }
  const code = src.code || 'IDENTITY_FAILED'
  const message = src.message || '无权访问平台管理'
  const hint = src.hint || ''
  if (BINDABLE_CODES.indexOf(code) >= 0) {
    return { allowed: false, needBind: true, code: code, message: message, hint: hint, admin: null }
  }
  return { allowed: false, needBind: false, code: code, message: message, hint: hint, admin: null }
}

/** 调 adminAuth.wxLogin：已绑定 → allowed；未绑定/口令错 → needBind；其他 → 拒绝 */
function checkAccess(cloudApi, payload) {
  const api = cloudApi || require('./api')
  return api
    .callFn('adminAuth', 'wxLogin', payload || {})
    .then(function (data) {
      return decidePlatformAccess({ ok: true, bound: true, admin: data && data.admin })
    })
    .catch(function (err) {
      return decidePlatformAccess({
        ok: false,
        code: (err && err.code) || 'IDENTITY_FAILED',
        message: (err && (err.message || err.errMsg)) || '身份校验失败',
        hint: (err && err.hint) || ''
      })
    })
}

function deny(message) {
  try {
    wx.showToast({ title: message || '无平台管理权限', icon: 'none' })
  } catch (err) {
    console.warn('[platform-guard] toast failed', err)
  }
  setTimeout(function () {
    try {
      wx.reLaunch({ url: MENU_PATH })
    } catch (err) {
      console.warn('[platform-guard] reLaunch failed', err)
    }
  }, 250)
}

module.exports = { MENU_PATH, BINDABLE_CODES, decidePlatformAccess, checkAccess, deny }
