'use strict'

/**
 * 当前商家上下文：
 *  - 分享卡片路径带 mid=<merchantId> 进入时写入本机；
 *  - 没有 mid 时使用 app.globalData.merchantId（默认商家）；
 *  - 所有 data-source 调用自动带上 merchantId，服务端会再次按身份校验。
 */

const STORAGE_KEY = 'ordering_merchant_id_v1'
const DEFAULT_MERCHANT_ID = 'merchant_001'
const MID_RE = /^[A-Za-z0-9_-]{1,64}$/

function getAppData() {
  try {
    if (typeof getApp === 'function') {
      const app = getApp()
      return (app && app.globalData) || {}
    }
  } catch (err) {
    return {}
  }
  return {}
}

function normalize(raw) {
  const value = String(raw === undefined || raw === null ? '' : raw).trim()
  return MID_RE.test(value) ? value : ''
}

function getMerchantId() {
  const data = getAppData()
  if (data.merchantId) return normalize(data.merchantId)
  try {
    if (typeof wx !== 'undefined' && wx.getStorageSync) {
      const saved = normalize(wx.getStorageSync(STORAGE_KEY))
      if (saved) return saved
    }
  } catch (err) {
    // ignore
  }
  return ''
}

function setMerchantId(raw) {
  const value = normalize(raw)
  if (!value) return ''
  const data = getAppData()
  data.merchantId = value
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) wx.setStorageSync(STORAGE_KEY, value)
  } catch (err) {
    console.warn('[merchant-context] 保存商家 ID 失败', err)
  }
  return value
}

/** 从页面 onLoad(options) 或 app onLaunch(options.query) 捕获 mid */
function capture(options) {
  const opts = options || {}
  const mid = opts.mid || (opts.query && opts.query.mid)
  if (mid) setMerchantId(mid)
  return getMerchantId()
}

/** 兼容旧调用：显式指定 merchantId（仅测试/管理调试） */
function withMerchant(payload) {
  const result = Object.assign({}, payload || {})
  if (!result.merchantId) {
    const mid = getMerchantId()
    if (mid) result.merchantId = mid
  }
  return result
}

/** 分享路径追加 mid；没有当前商家时保持原路径 */
function appendMid(url) {
  const path = String(url || '')
  const mid = getMerchantId()
  if (!mid) return path
  return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'mid=' + encodeURIComponent(mid)
}

module.exports = {
  STORAGE_KEY,
  DEFAULT_MERCHANT_ID,
  getMerchantId,
  setMerchantId,
  capture,
  withMerchant,
  appendMid
}
