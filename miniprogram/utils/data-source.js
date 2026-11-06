'use strict'

/**
 * 唯一数据入口：所有页面都只调用本模块，不直接判断 cloud / local。
 *  - cloud：走原有 wx.cloud.callFunction（cloudfunctions/api、pay）
 *  - local：走本地演示后端（wx storage 持久化 + 复用 core 纯逻辑，免云开发）
 *
 * 模式优先级：运行期 globalData.dataMode > 本机覆盖存储 > app.js 的 DATA_MODE（默认 cloud）
 */

const cloudApi = require('./api')
const localBackendFactory = require('./local-backend')
const localStore = require('./local-store')

const MODE_CLOUD = 'cloud'
const MODE_LOCAL = 'local'
const DEFAULT_MODE = MODE_CLOUD
const MODE_STORAGE_KEY = 'ordering_data_mode_v1'

let localBackend = null
let cloudReady = false

function getAppSafe() {
  try {
    if (typeof getApp === 'function') return getApp() || null
    return null
  } catch (err) {
    return null
  }
}

function getGlobalData() {
  const app = getAppSafe()
  return (app && app.globalData) || {}
}

function readSavedMode() {
  try {
    if (typeof wx !== 'undefined' && wx.getStorageSync) {
      const saved = wx.getStorageSync(MODE_STORAGE_KEY)
      if (saved === MODE_LOCAL || saved === MODE_CLOUD) return saved
    }
  } catch (err) {
    // ignore
  }
  return ''
}

function getMode() {
  const data = getGlobalData()
  if (data.dataMode === MODE_LOCAL || data.dataMode === MODE_CLOUD) return data.dataMode
  const saved = readSavedMode()
  return saved || DEFAULT_MODE
}

function isLocalMode() {
  return getMode() === MODE_LOCAL
}

function modeLabel() {
  return isLocalMode() ? '本地演示模式（免云开发）' : '云端模式'
}

function getCloudEnv() {
  const data = getGlobalData()
  return data.cloudEnv || ''
}

function envStatus(env) {
  const value = String(env || '').trim()
  if (!value) return { ok: false, key: 'empty', message: 'CLOUD_ENV 为空' }
  if (/xxxx|your[-_]?env|环境ID|示例/i.test(value)) {
    return { ok: false, key: 'placeholder', message: 'CLOUD_ENV 仍是占位内容' }
  }
  return { ok: true, key: 'configured', message: '已配置' }
}

function getEnvInfo() {
  const mode = getMode()
  const cloudEnv = getCloudEnv()
  const status = envStatus(cloudEnv)
  return {
    mode,
    modeLabel: modeLabel(),
    isLocal: mode === MODE_LOCAL,
    cloudEnv,
    envStatus: status,
    hasCloud: typeof wx !== 'undefined' && !!wx.cloud,
    cloudReady
  }
}

/** 云开发初始化（可重复调用；local 模式下不调用） */
function initCloud(options) {
  if (cloudReady) return true
  if (typeof wx === 'undefined' || !wx.cloud) return false
  const opts = options || {}
  const env = opts.env || getCloudEnv()
  const initOptions = { traceUser: true }
  if (env) initOptions.env = env
  try {
    wx.cloud.init(initOptions)
    cloudReady = true
    return true
  } catch (err) {
    console.error('[data-source] wx.cloud.init 失败', err)
    return false
  }
}

function ensureCloudReady() {
  if (cloudReady) return true
  if (typeof wx === 'undefined' || !wx.cloud) {
    const err = new Error('当前基础库不支持云开发（需要 2.2.3 及以上，且使用小程序模式打开）')
    err.code = 'CLOUD_UNAVAILABLE'
    throw err
  }
  return initCloud()
}

function getBackend() {
  if (!localBackend) {
    localBackend = localBackendFactory.createLocalBackend({ storage: localStore })
  }
  return localBackend
}

/** 切回云端时清掉本地角色与演示数据，避免两套数据混用 */
function clearLocalSession() {
  if (localBackend && typeof localBackend.run === 'function') {
    try {
      localBackend.run('merchant.switchRole', { merchant: false })
    } catch (err) {
      console.warn('[data-source] 清除本地商家标记失败', err)
    }
  }
  if (localBackend && typeof localBackend.reset === 'function') {
    localBackend.reset()
  }
  localBackend = null
}

function call(action, payload) {
  if (getMode() === MODE_LOCAL) {
    try {
      return Promise.resolve(getBackend().run(action, payload))
    } catch (err) {
      return Promise.reject(err)
    }
  }
  try {
    ensureCloudReady()
  } catch (err) {
    return Promise.reject(err)
  }
  return cloudApi.call(action, payload)
}

function callPayment(action, payload) {
  if (getMode() === MODE_LOCAL) {
    try {
      return Promise.resolve(getBackend().run(action, payload))
    } catch (err) {
      return Promise.reject(err)
    }
  }
  try {
    ensureCloudReady()
  } catch (err) {
    return Promise.reject(err)
  }
  return cloudApi.callPayment(action, payload)
}

/**
 * 把任意错误整理成页面可直接展示的信息（含针对性修复建议），不直接吞掉。
 */
function describeError(err) {
  const code = (err && (err.code || err.errCode)) || 'UNKNOWN'
  const message = (err && (err.message || err.errMsg)) || '未知错误'
  const mode = getMode()
  let hint = ''

  if (code === 'CLOUD_UNAVAILABLE') {
    hint = '当前基础库或运行环境不支持云开发：请使用微信开发者工具的小程序模式，并把调试基础库调到 2.2.3 以上。'
  } else if (code === 'CALL_FAILED') {
    hint = '云函数 api 不可达：确认 cloudfunctions/api 已「上传并部署（云端安装依赖）」，并检查 app.js 的 CLOUD_ENV 是否正确；可打开「自检」页逐项排查。'
  } else if (code === 'BAD_RESPONSE') {
    hint = '云函数返回格式异常：多半是云端代码不是最新版本，请重新部署 cloudfunctions/api。'
  } else if (code === 'UNKNOWN_ACTION') {
    hint = '云端不认识该接口：请重新部署 cloudfunctions/api，确保 handlers/router.js 为最新版本。'
  } else if (code === 'INTERNAL_ERROR') {
    hint = '云函数内部异常：打开云开发控制台 → 云函数 → api → 日志查看堆栈；也可用「自检」页定位。'
  } else if (mode === MODE_LOCAL) {
    hint = '当前为本地演示模式（数据只保存在本机，不会写入云端）。可在「自检」页切回云端模式。'
  } else {
    hint = '可打开「自检」页检查云环境、云函数部署、数据库集合与今日菜单状态。'
  }

  return { code, message, hint, mode, modeLabel: modeLabel() }
}

function showError(err, title, options) {
  console.error('[data-source] ' + (title || '操作失败'), err)
  const info = describeError(err)
  const opts = options || {}
  if (typeof wx === 'undefined' || !wx.showModal) return info

  // 云端不可达时给两个显式动作：重试 / 用本地演示（绝不自动切换模式）
  const cloudFail =
    info.mode === MODE_CLOUD &&
    (info.code === 'CALL_FAILED' || info.code === 'CLOUD_UNAVAILABLE' || info.code === 'NO_CLOUD_ENV')
  if (cloudFail) {
    wx.showModal({
      title: title || '云端不可用',
      content:
        '云端不可用：' + info.code + ' ' + info.message +
        '\n\n' + (info.hint || '') +
        '\n\n「用本地演示模式」的数据只保存在本机，不会写入云端，其他人看不到。',
      confirmText: '重试',
      cancelText: '用本地演示',
      success(res) {
        if (res.confirm) {
          if (typeof opts.onRetry === 'function') opts.onRetry()
        } else if (res.cancel) {
          switchToLocal()
        }
      }
    })
    return info
  }

  wx.showModal({
    title: title || '操作失败',
    content: info.code + '：' + info.message + (info.hint ? '\n\n' + info.hint : ''),
    showCancel: false,
    confirmText: '知道了'
  })
  return info
}

/** 切换数据模式（会写入本机覆盖配置并重启到首页） */
function setMode(mode, options) {
  const next = mode === MODE_LOCAL ? MODE_LOCAL : MODE_CLOUD
  const opts = options || {}
  const app = getAppSafe()
  if (app && app.globalData) app.globalData.dataMode = next
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) wx.setStorageSync(MODE_STORAGE_KEY, next)
  } catch (err) {
    console.warn('[data-source] 保存数据模式失败', err)
  }
  if (next === MODE_CLOUD) {
    clearLocalSession()
    if (app && app.globalData) {
      app.globalData.isMerchant = false
      app.globalData.identity = null
    }
    initCloud()
  }
  if (!opts.silent && typeof wx !== 'undefined' && wx.reLaunch) {
    wx.reLaunch({ url: opts.url || '/pages/menu/menu' })
  }
  return next
}

function switchToLocal(options) {
  return setMode(MODE_LOCAL, options)
}

function switchToCloud(options) {
  return setMode(MODE_CLOUD, options)
}

/** 启动身份识别：openid + 是否商家（cloud 走 whoami，local 走本地标记） */
function whoami() {
  return call('whoami')
}

/** 进入商家视图：local 会写入本地商家标记；cloud 直接跳转（由 whoami 决定是否放行） */
function enterMerchantView(options) {
  const opts = options || {}
  if (getMode() === MODE_LOCAL) {
    try {
      getBackend().run('merchant.switchRole', { merchant: true })
    } catch (err) {
      showError(err, '切换商家视图失败')
      return
    }
  }
  if (typeof wx !== 'undefined' && wx.reLaunch) {
    wx.reLaunch({ url: opts.url || '/pages/merchant/index/index' })
  }
}

/** 切换到顾客视图：local 清除本地商家标记 */
function exitMerchantView(options) {
  const opts = options || {}
  if (getMode() === MODE_LOCAL) {
    try {
      getBackend().run('merchant.switchRole', { merchant: false })
    } catch (err) {
      console.warn('[data-source] 清除本地商家标记失败', err)
    }
  }
  if (typeof wx !== 'undefined' && wx.reLaunch) {
    wx.reLaunch({ url: opts.url || '/pages/menu/menu' })
  }
}

/** 一次性把当前 openid 设为商家（仅空集合 + 手动点击） */
function claimSelfMerchant() {
  return call('merchant.claimSelf', { confirm: true })
}

module.exports = {
  MODE_CLOUD,
  MODE_LOCAL,
  DEFAULT_MODE,
  MODE_STORAGE_KEY,
  getMode,
  isLocalMode,
  modeLabel,
  getCloudEnv,
  getEnvInfo,
  initCloud,
  call,
  callPayment,
  describeError,
  showError,
  setMode,
  switchToLocal,
  switchToCloud,
  whoami,
  enterMerchantView,
  exitMerchantView,
  claimSelfMerchant,
  // 兼容原有 utils/api 的导出形态
  callFn: cloudApi.callFn,
  resetLocalData() {
    if (localBackend) localBackend.reset()
    localBackend = null
  }
}
