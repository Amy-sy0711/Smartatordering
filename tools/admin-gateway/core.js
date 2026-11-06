'use strict'

/**
 * 本地网关（B2）的纯逻辑：路由白名单、本机口令、access_token 缓存、错误映射。
 * 零依赖，可离线单测。
 */

/** 只允许平台管理需要的 action；绝不放行订单/菜品/顾客等业务明细 */
const ALLOWED_ACTIONS = [
  'merchant.list',
  'merchant.create',
  'merchant.update',
  'merchant.setStatus',
  'merchant.setFlags',
  'merchant.resetPassword',
  'staff.list',
  'staff.bind',
  'staff.unbind',
  'health',
  'audit.list',
  'error.summary',
  'repair.rebuildIndexes',
  'repair.seedDefaults',
  'repair.cleanOrphans',
  'repair.resetStaff',
  'repair.revokeTokens',
  'repair.refreshMenuCache',
  'repair.resendPaymentCallback',
  'admin.changePassword'
]

const FORBIDDEN_ACTIONS = [
  'orders',
  'merchant.orders',
  'order.list',
  'order.detail',
  'merchant.exportOrders',
  'dishes',
  'merchant.dishes',
  'dish.list',
  'menu.detail',
  'menu.today',
  'customers',
  'customer.list',
  'stats',
  'merchant.stats',
  'payment.records',
  'payment.list'
]

const WX_ERRORS = {
  '40001': 'access_token 无效（常见于重置了 AppSecret）。网关会自动刷新并重试一次；仍失败请核对 WX_APPSECRET。',
  '40013': 'AppID 无效，请核对 WX_APPID（小程序后台 → 开发管理 → 开发设置）。',
  '42001': 'access_token 已过期。网关会自动刷新并重试一次。',
  '45009': '接口调用频率超限，请稍后再试。',
  '-1': '微信系统繁忙，请稍后重试。',
  '0': '调用成功'
}

function normalizeAction(name) {
  const raw = String(name || '').trim()
  if (!raw) return ''
  return raw.replace(/^adminApi\//i, '').replace(/^\/+/, '')
}

function isAllowedAction(name) {
  const action = normalizeAction(name)
  if (!action) return false
  if (FORBIDDEN_ACTIONS.indexOf(action) >= 0) return false
  return ALLOWED_ACTIONS.indexOf(action) >= 0
}

function extractToken(headers, query) {
  const source = headers || {}
  const headerKey = Object.keys(source).filter((item) => item.toLowerCase() === 'x-admin-token')[0]
  if (headerKey && String(source[headerKey] || '')) return String(source[headerKey])
  const querySource = query || {}
  const queryKey = Object.keys(querySource).filter((item) => item.toLowerCase() === 'token')[0]
  if (queryKey && String(querySource[queryKey] || '')) return String(querySource[queryKey])
  return ''
}

function extractGatewayToken(headers, query) {
  const source = headers || {}
  const headerKey = Object.keys(source).filter((item) => item.toLowerCase() === 'x-gateway-token')[0]
  if (headerKey && String(source[headerKey] || '')) return String(source[headerKey])
  const querySource = query || {}
  const queryKey = Object.keys(querySource).filter((item) => item.toLowerCase() === 'gateway')[0]
  if (queryKey && String(querySource[queryKey] || '')) return String(querySource[queryKey])
  return ''
}

/** 定长比较，避免 timingSafeEqual 之外的短路差异 */
function safeEqual(a, b) {
  const left = String(a || '')
  const right = String(b || '')
  if (left.length !== right.length) return false
  let diff = 0
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i)
  return diff === 0
}

function checkGatewayToken(provided, expected) {
  if (!expected) return true
  return safeEqual(provided, expected)
}

/**
 * access_token 缓存：有效期 7000 秒，提前 200 秒刷新；并发请求共享同一个 inflight。
 * 返回 { get(force?), reset(), snapshot() }
 */
function createTokenCache(options) {
  const opts = options || {}
  const ttl = Number(opts.ttl) || 7000
  const refreshBefore = Number(opts.refreshBefore) || 200
  const now = opts.now || Date.now
  const state = { token: '', expiresAt: 0, inflight: null }

  function valid() {
    return Boolean(state.token) && state.expiresAt - now() > refreshBefore * 1000
  }

  function get(force) {
    if (!force && valid()) return Promise.resolve(state.token)
    if (state.inflight) return state.inflight
    state.inflight = Promise.resolve()
      .then(() => opts.fetchToken())
      .then((res) => {
        if (!res || !res.access_token) {
          state.token = ''
          state.expiresAt = 0
          const err = new Error((res && (res.errmsg || res.message)) || '获取 access_token 失败')
          err.errcode = res && res.errcode
          throw err
        }
        state.token = String(res.access_token)
        state.expiresAt = now() + (Number(res.expires_in) || ttl) * 1000
        return state.token
      })
      .finally(() => {
        state.inflight = null
      })
    return state.inflight
  }

  function reset() {
    state.token = ''
    state.expiresAt = 0
  }

  return {
    get: get,
    reset: reset,
    snapshot: function () {
      return { token: state.token, expiresAt: state.expiresAt }
    }
  }
}

/** 微信侧错误码 → 可读文案 */
function mapWxError(errcode, errmsg) {
  const key = String(errcode === undefined || errcode === null ? '' : errcode)
  const text = WX_ERRORS[key]
  return {
    code: 'WX_' + (key || 'UNKNOWN'),
    message: text || String(errmsg || '微信接口调用失败'),
    errcode: errcode,
    retryable: key === '40001' || key === '42001' || key === '-1'
  }
}

/** 解析 invokecloudfunction 响应：{errcode, errmsg, resp_data} */
function parseInvokeResult(body) {
  let value = body
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch (err) {
      return { ok: false, code: 'BAD_UPSTREAM_JSON', message: '云函数返回非 JSON：' + String(body).slice(0, 160) }
    }
  }
  if (!value || typeof value !== 'object') {
    return { ok: false, code: 'EMPTY_UPSTREAM', message: '云函数返回为空' }
  }
  if (value.errcode !== undefined && Number(value.errcode) !== 0) {
    const mapped = mapWxError(value.errcode, value.errmsg)
    return { ok: false, code: mapped.code, message: mapped.message, errcode: value.errcode, retryable: mapped.retryable }
  }
  let data = value.resp_data !== undefined ? value.resp_data : value
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data)
    } catch (err) {
      return { ok: false, code: 'BAD_RESP_DATA', message: '云函数 resp_data 不是 JSON：' + String(data).slice(0, 160) }
    }
  }
  return { ok: true, data: data }
}

function corsHeaders(origin, allowedOrigins) {
  const list = Array.isArray(allowedOrigins) ? allowedOrigins : []
  const allow = list.length ? (list.indexOf(origin) >= 0 ? origin : list[0]) : (origin || '*')
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'content-type,x-admin-token,x-gateway-token',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'Content-Type': 'application/json; charset=utf-8'
  }
}

/* ------------------------- 网关注入配置（静态页同源） ------------------------- */

const GATEWAY_PLACEHOLDER = '<!--GATEWAY_CONFIG-->'

/** 注入给管理台的配置：mode/base 固定，token 只在本机页面里存在，不落盘 */
function buildGatewayConfig(gatewayToken, base) {
  return {
    mode: 'gateway',
    base: String(base || '/api'),
    token: String(gatewayToken || '')
  }
}

/** 把占位符替换成 window.__GATEWAY__ 脚本；没有占位符时插到 </head> 前 */
function injectGatewayConfig(html, config) {
  const source = String(html || '')
  const json = JSON.stringify(config || buildGatewayConfig('', '/api')).replace(/</g, '\\u003c')
  const script = '<script>window.__GATEWAY__ = ' + json + ';</script>'
  if (source.indexOf(GATEWAY_PLACEHOLDER) >= 0) return source.split(GATEWAY_PLACEHOLDER).join(script)
  if (source.indexOf('</head>') >= 0) return source.replace('</head>', script + '\n</head>')
  return script + source
}

/** 注入配置优先级最高：只要有 __GATEWAY__，就强制 gateway 模式，忽略本地保存的其它模式 */
function resolveMode(gatewayConfig, savedMode) {
  if (gatewayConfig && String(gatewayConfig.mode || '') === 'gateway') return 'gateway'
  const saved = String(savedMode || '')
  return saved === 'cloud' || saved === 'local' ? saved : 'local'
}

/** /api/admin 请求体：管理员 token 提为顶层，payload 内不再重复携带 */
function buildAdminRequest(adminToken, action, payload) {
  const input = payload || {}
  const out = Object.assign({}, input)
  delete out.token
  return {
    token: String(adminToken || input.token || ''),
    action: normalizeAction(action),
    payload: out
  }
}

module.exports = {
  ALLOWED_ACTIONS,
  FORBIDDEN_ACTIONS,
  WX_ERRORS,
  GATEWAY_PLACEHOLDER,
  normalizeAction,
  isAllowedAction,
  extractToken,
  extractGatewayToken,
  safeEqual,
  checkGatewayToken,
  createTokenCache,
  mapWxError,
  parseInvokeResult,
  corsHeaders,
  buildGatewayConfig,
  injectGatewayConfig,
  resolveMode,
  buildAdminRequest
}
