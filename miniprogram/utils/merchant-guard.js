'use strict'

const MENU_PATH = 'pages/menu/menu'

function decideAccess(info) {
  const src = info || {}
  if (src.isMerchant === true) {
    return { allowed: true, code: 'OK', message: '' }
  }
  return { allowed: false, code: 'NO_MERCHANT_ACCESS', message: '当前账号不是商家，无法进入商家端' }
}

function deny(reason) {
  try {
    wx.showToast({ title: reason || '无商家权限', icon: 'none' })
  } catch (err) {
    console.warn('[guard] toast failed', err)
  }
  setTimeout(() => {
    wx.reLaunch({ url: '/' + MENU_PATH })
  }, 250)
}

function requireMerchant() {
  const api = require('./data-source')
  return api
    .call('merchant.checkAccess', { claim: false })
    .then((info) => {
      const decision = decideAccess(info)
      if (decision.allowed) {
        try {
          getApp().globalData.isMerchant = true
        } catch (err) {
          console.warn('[guard] set isMerchant failed', err)
        }
        return info
      }
      const error = new Error(decision.message)
      error.code = decision.code
      throw error
    })
    .catch((err) => {
      console.error('[guard] 商家权限校验失败', err)
      deny('无商家权限')
      const error = err instanceof Error ? err : new Error('身份校验失败')
      if (!error.code) error.code = 'IDENTITY_FAILED'
      throw error
    })
}

module.exports = { requireMerchant, decideAccess, MENU_PATH }
