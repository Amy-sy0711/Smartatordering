'use strict'

/**
 * 本地管理网关（浏览器版管理台的唯一推荐链路）
 *
 *  - 只监听 127.0.0.1:8787，供本机浏览器使用
 *  - 静态托管 deploy/admin-console（访问 http://127.0.0.1:8787/ 即可，无 CORS）
 *  - /api/* 转发到微信云开发 HTTP API：
 *      access_token ← https://api.weixin.qq.com/cgi-bin/token（缓存 7000 秒，提前 200 秒刷新）
 *      云函数调用   ← https://api.weixin.qq.com/tcb/invokecloudfunction
 *  - 管理员 token 由 adminAuth / adminApi 正常签发与校验；AppSecret 只在网关进程内
 *
 * 环境变量：
 *   WX_APPID / WX_APPSECRET   小程序后台 → 开发管理 → 开发设置
 *   TCB_ENV_ID                云开发环境 ID（默认 ordering-d0gyct6z1ff2afebd）
 *   GATEWAY_TOKEN             可选；不设则随机生成并写入 tools/admin-gateway/.env.local
 *   GATEWAY_PORT              可选，默认 8787
 */

const fs = require('fs')
const path = require('path')
const http = require('http')
const crypto = require('crypto')
const core = require('./core')

const HOST = '127.0.0.1'
const PORT = Number(process.env.GATEWAY_PORT || process.env.ADMIN_GATEWAY_PORT || 8787)
const ENV_ID = String(process.env.TCB_ENV_ID || 'ordering-d0gyct6z1ff2afebd')
const APP_ID = String(process.env.WX_APPID || '')
const APP_SECRET = String(process.env.WX_APPSECRET || '')
const STATIC_DIR = path.resolve(__dirname, '..', '..', 'deploy', 'admin-console')
const ENV_FILE = path.join(__dirname, '.env.local')

function loadLocalEnv() {
  if (!fs.existsSync(ENV_FILE)) return
  const text = fs.readFileSync(ENV_FILE, 'utf8')
  text.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.charAt(0) === '#') return
    const idx = trimmed.indexOf('=')
    if (idx < 0) return
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    if (key && !process.env[key]) process.env[key] = value
  })
}

loadLocalEnv()
const GATEWAY_TOKEN = String(process.env.GATEWAY_TOKEN || '')

function ensureGatewayToken() {
  if (GATEWAY_TOKEN) return GATEWAY_TOKEN
  const generated = crypto.randomBytes(24).toString('hex')
  try {
    fs.appendFileSync(ENV_FILE, '# 本地网关口令，仅本机使用，已被 .gitignore 排除\nGATEWAY_TOKEN=' + generated + '\n')
  } catch (err) {
    console.warn('[warn] 无法写入 .env.local：' + err.message)
  }
  process.env.GATEWAY_TOKEN = generated
  return generated
}

const TOKEN = ensureGatewayToken()

if (!APP_ID || !APP_SECRET) {
  console.error('===============================================')
  console.error('[错误] 缺少 WX_APPID / WX_APPSECRET，网关未启动。')
  console.error('获取路径：微信公众平台（mp.weixin.qq.com）→ 开发管理 → 开发设置 → AppSecret（需管理员扫码重置后复制）')
  console.error('设置方式（PowerShell，仅当前窗口）：')
  console.error('  $env:WX_APPID="wx..."')
  console.error('  $env:WX_APPSECRET="..."')
  console.error('  $env:TCB_ENV_ID="' + ENV_ID + '"')
  console.error('  npm start')
  console.error('===============================================')
  process.exit(1)
}

const tokenCache = core.createTokenCache({
  ttl: 7000,
  refreshBefore: 200,
  fetchToken: async function () {
    const url =
      'https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential' +
      '&appid=' + encodeURIComponent(APP_ID) +
      '&secret=' + encodeURIComponent(APP_SECRET)
    const res = await fetch(url, { method: 'GET' })
    return res.json()
  }
})

let tokenFetchedAt = 0
async function accessToken(force) {
  const token = await tokenCache.get(!!force)
  tokenFetchedAt = Date.now()
  return token
}

/** 调用云函数（微信云开发 HTTP API），40001/42001 自动刷新 token 重试一次 */
async function invokeCloudFunction(name, payload) {
  async function once(force) {
    const token = await accessToken(force)
    const url =
      'https://api.weixin.qq.com/tcb/invokecloudfunction?access_token=' + encodeURIComponent(token) +
      '&env=' + encodeURIComponent(ENV_ID) +
      '&name=' + encodeURIComponent(name)
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {})
    })
    const body = await res.json()
    return core.parseInvokeResult(body)
  }
  const first = await once(false)
  if (!first.ok && first.retryable) {
    tokenCache.reset()
    return once(true)
  }
  return first
}

async function handleLogin(body, gatewayToken) {
  if (!core.checkGatewayToken(gatewayToken, TOKEN)) {
    return { status: 401, body: { code: 'GATEWAY_TOKEN_INVALID', message: '本机口令不正确，请使用启动时打印的 token' } }
  }
  const payload = { action: 'login', payload: { username: body.username, password: body.password } }
  const result = await invokeCloudFunction('adminAuth', payload)
  if (!result.ok) return { status: 200, body: { code: result.code, message: result.message, retryable: !!result.retryable } }
  return { status: 200, body: result.data }
}

async function handleAdmin(body, gatewayToken) {
  if (!core.checkGatewayToken(gatewayToken, TOKEN)) {
    return { status: 401, body: { code: 'GATEWAY_TOKEN_INVALID', message: '本机口令不正确，请使用启动时打印的 token' } }
  }
  const action = core.normalizeAction(body.action)
  const isAuthAction = action === 'login' || action === 'precheck' || action === 'verify'
  const target = String(body.name || '') === 'adminAuth' || isAuthAction ? 'adminAuth' : 'adminApi'
  if (target === 'adminAuth') {
    if (['login', 'precheck', 'verify'].indexOf(action) < 0) {
      return { status: 403, body: { code: 'FORBIDDEN_ACTION', message: '本地网关仅转发 adminAuth 的 login/precheck/verify' } }
    }
    const authResult = await invokeCloudFunction('adminAuth', { action: action, payload: body.payload || {} })
    if (!authResult.ok) {
      return { status: 200, body: { code: authResult.code, message: authResult.message, retryable: !!authResult.retryable } }
    }
    return { status: 200, body: authResult.data }
  }
  if (!core.isAllowedAction(action)) {
    return {
      status: 403,
      body: {
        code: 'FORBIDDEN_ACTION',
        message: '本地网关拒绝该接口（只允许平台管理接口，禁止订单/菜品/顾客明细）：' + (action || '(空)')
      }
    }
  }
  const payload = Object.assign({}, body.payload || {})
  const adminToken = String(body.token || payload.token || core.extractToken(body.headers || {}, {}))
  const request = core.buildAdminRequest(adminToken, action, payload)
  const result = await invokeCloudFunction('adminApi', request)
  if (!result.ok) {
    return { status: 200, body: { code: result.code, message: result.message, hint: result.retryable ? 'access_token 已自动刷新重试一次仍失败，请核对 AppID/AppSecret。' : '', retryable: !!result.retryable } }
  }
  return { status: 200, body: result.data }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8'
}

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(STATIC_DIR)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('缺少静态目录：' + STATIC_DIR)
    return
  }
  let rel = pathname === '/' ? '/index.html' : pathname
  try {
    rel = decodeURIComponent(rel)
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Bad path')
    return
  }
  const target = path.resolve(STATIC_DIR, '.' + rel)
  if (!target.startsWith(STATIC_DIR + path.sep) && target !== path.join(STATIC_DIR, 'index.html')) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Forbidden')
    return
  }
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not found：' + rel)
    return
  }
  const ext = path.extname(target).toLowerCase()
  if (ext === '.html' && path.basename(target).toLowerCase() === 'index.html') {
    // 同源托管时把网关配置直接注入页面：管理台无需填写地址/口令，也不会走匿名登录
    const html = core.injectGatewayConfig(fs.readFileSync(target, 'utf8'), core.buildGatewayConfig(TOKEN, '/api'))
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' })
    res.end(html)
    return
  }
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' })
  res.end(fs.readFileSync(target))
}

function readBody(req) {
  return new Promise((resolve) => {
    let text = ''
    req.on('data', (chunk) => {
      text += chunk
      if (text.length > 2 * 1024 * 1024) text = text.slice(0, 2 * 1024 * 1024)
    })
    req.on('end', () => {
      if (!text) return resolve({})
      try {
        const value = JSON.parse(text)
        resolve(value && typeof value === 'object' && !Array.isArray(value) ? value : null)
      } catch (err) {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function sendJson(res, status, payload, origin) {
  res.writeHead(status, core.corsHeaders(origin, []))
  res.end(JSON.stringify(payload))
}

const server = http.createServer(async (req, res) => {
  const origin = String((req.headers && req.headers.origin) || '')
  const url = new URL(req.url, 'http://' + HOST + ':' + PORT)
  const pathname = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, core.corsHeaders(origin, []))
    res.end('')
    return
  }

  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      service: 'admin-gateway',
      envId: ENV_ID,
      gatewayTokenRequired: true,
      tokenCached: Boolean(tokenCache.snapshot().token),
      fetchedAt: tokenFetchedAt || null
    }, origin)
    return
  }

  if (pathname.indexOf('/api') === 0) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: '本地网关 API 仅支持 POST' }, origin)
      return
    }
    const body = await readBody(req)
    if (!body) {
      sendJson(res, 400, { code: 'BAD_JSON', message: '请求体必须是 JSON 对象' }, origin)
      return
    }
    const gatewayToken = core.extractGatewayToken(req.headers, {
      gateway: url.searchParams.get('gateway') || ''
    })
    try {
      if (pathname === '/api/login') {
        const result = await handleLogin(body, gatewayToken)
        sendJson(res, result.status, result.body, origin)
        return
      }
      const result = await handleAdmin(body, gatewayToken)
      sendJson(res, result.status, result.body, origin)
    } catch (err) {
      const mapped = core.mapWxError(err && err.errcode, err && err.message)
      sendJson(res, 500, {
        code: err.code || mapped.code,
        message: (err && err.message) || mapped.message,
        hint: '检查本机网络能否访问 api.weixin.qq.com，以及 WX_APPID / WX_APPSECRET 是否正确。'
      }, origin)
    }
    return
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED', message: '静态资源仅支持 GET' }, origin)
    return
  }
  serveStatic(req, res, pathname)
})

server.listen(PORT, HOST, () => {
  console.log('===============================================')
  console.log('本地管理网关已启动：http://' + HOST + ':' + PORT)
  console.log('浏览器直接打开：http://' + HOST + ':' + PORT + '/')
  console.log('管理台连接地址：http://' + HOST + ':' + PORT + '/api')
  console.log('本机口令（管理台首次打开会自动带入，或手动粘贴）：' + TOKEN)
  console.log('环境 ID：' + ENV_ID + ' · AppID：' + APP_ID.slice(0, 6) + '***')
  console.log('只监听 127.0.0.1，不要绑定 0.0.0.0，也不要把 8787 映射到公网。')
  console.log('===============================================')
})
