'use strict'

const cloud = require('wx-server-sdk')
const security = require('./core/security')
const core = require('./core/auth-core')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const ADMINS = 'admins'

function ok(data) {
  return { code: 0, data }
}

function fail(code, message, hint) {
  return core.fail(code, message, hint)
}

function envText(name) {
  return String(process.env[name] || '')
}

/** 只返回「是否配置」，绝不返回变量内容 */
function envState() {
  return {
    bootstrap: envText('ADMIN_BOOTSTRAP_PASSWORD').length > 0,
    tokenSecret: envText('ADMIN_TOKEN_SECRET').length >= 16
  }
}

/**
 * 查询 admins 集合状态：
 *  - 集合不存在（-502005）→ exists:false，由登录流程决定是否自动创建
 *  - 权限等其他错误 → errorText 有值，直接失败，绝不误判为「集合不存在」
 */
async function collectionState() {
  try {
    const res = await db.collection(ADMINS).count()
    return { exists: true, total: (res && res.total) || 0, errorText: '' }
  } catch (err) {
    if (core.isCollectionMissing(err)) return { exists: false, total: 0, errorText: '' }
    return {
      exists: false,
      total: 0,
      errorText: String((err && (err.errMsg || err.message)) || '数据库查询失败')
    }
  }
}

async function findAdminByUsername(username) {
  const res = await db.collection(ADMINS).where({ username }).limit(1).get()
  return (res && res.data && res.data[0]) || null
}

/** 首次初始化时自动建集合；老版本 SDK 不支持则给出明确修法 */
async function ensureCollection() {
  if (typeof db.createCollection !== 'function') {
    return {
      ok: false,
      message: '当前 wx-server-sdk 不支持 db.createCollection',
      hint: '请在云开发控制台 → 数据库 → 新建集合 admins（权限设为仅管理端可读写），然后重新登录。'
    }
  }
  try {
    await db.createCollection(ADMINS)
    return { ok: true, created: true }
  } catch (err) {
    const msg = String((err && (err.errMsg || err.message)) || '')
    if (/already\s*exist|已存在|duplicate/i.test(msg)) return { ok: true, created: false }
    return {
      ok: false,
      message: '自动创建 admins 集合失败：' + (msg || '未知错误'),
      hint: '请在云开发控制台 → 数据库 → 新建集合 admins 后重试。'
    }
  }
}

function describeCaller(event) {
  let ctx = {}
  try {
    ctx = cloud.getWXContext() || {}
  } catch (err) {
    ctx = {}
  }
  const userInfo = (event && event.userInfo) || {}
  const uid = String(ctx.OPENID || ctx.CUSTOM_USER_ID || userInfo.openId || userInfo.openid || '')
  return {
    uid: uid,
    hasUid: Boolean(uid),
    source: String(ctx.SOURCE || (event && event.source) || '')
  }
}

/**
 * 登录：
 *  - 已有管理员：校验用户名 + scrypt 密码
 *  - 集合为空（或集合不存在）：允许用环境变量 ADMIN_BOOTSTRAP_PASSWORD 创建第一个管理员（一次性）
 */
async function login(payload) {
  const username = String(payload.username || '').trim()
  const password = String(payload.password || '')
  if (!username || username.length > 32) return fail('USERNAME_INVALID')
  if (!password) return fail('PASSWORD_REQUIRED')

  const envs = envState()
  const collection = await collectionState()

  let admin = null
  if (collection.exists) admin = await findAdminByUsername(username)

  const plan = core.planLogin({
    collectionErrorText: collection.errorText,
    tokenSecretOk: envs.tokenSecret,
    collectionExists: collection.exists,
    adminTotal: collection.total,
    adminFound: Boolean(admin),
    passwordMatches: admin ? security.verifyPassword(password, admin.passwordHash) : false,
    hasBootstrap: envs.bootstrap,
    bootstrapMatches: envs.bootstrap ? password === envText('ADMIN_BOOTSTRAP_PASSWORD') : false
  })
  if (!plan.ok) return plan

  if (plan.mode === 'bootstrap') {
    if (plan.createCollection) {
      const ensured = await ensureCollection()
      if (!ensured.ok) return fail('ADMINS_COLLECTION_MISSING', ensured.message, ensured.hint)
    }
    const adminId = security.newAdminId()
    const doc = {
      adminId: adminId,
      username: username,
      passwordHash: security.hashPassword(password),
      role: 'platform_admin',
      createdAt: new Date()
    }
    try {
      await db.collection(ADMINS).doc(adminId).set({ data: doc })
    } catch (err) {
      if (core.isCollectionMissing(err)) return fail('ADMINS_COLLECTION_MISSING')
      return fail('INTERNAL_ERROR', '写入管理员失败：' + String((err && (err.errMsg || err.message)) || '未知错误'))
    }
    admin = Object.assign({ _id: adminId }, doc)
  }

  const token = security.signToken({ adminId: admin._id || admin.adminId, username: admin.username })
  return ok({
    token: token,
    admin: { adminId: admin._id || admin.adminId, username: admin.username }
  })
}

async function findAdminByOpenid(openid) {
  if (!openid) return null
  const res = await db.collection(ADMINS).where({ openid }).limit(1).get()
  return (res && res.data && res.data[0]) || null
}

async function bindOpenid(admin, uid) {
  const adminId = admin._id || admin.adminId
  if (!adminId) return
  await db.collection(ADMINS).doc(adminId).update({
    data: { openid: uid, openidBoundAt: new Date(), updatedAt: new Date() }
  })
}

/**
 * 小程序内平台管理员登录 / 绑定（不依赖浏览器匿名登录，也不依赖 Web 安全域名）：
 *  1) 当前 openid 已绑定 admins.openid → 直接放行
 *  2) 提交管理员账号 + 密码且校验通过 → 把当前 openid 绑到该管理员记录
 *  3) admins 为空（或集合不存在）→ 用 ADMIN_BOOTSTRAP_PASSWORD 创建第一个管理员并绑定 openid
 * 小程序内后续调用 adminApi 直接用 openid 鉴权，不把 token 存在本地。
 */
async function wxLogin(payload, event) {
  const caller = describeCaller(event)
  const uid = caller.uid
  const envs = envState()
  const collection = await collectionState()

  const username = String(payload.username || '').trim()
  const password = String(payload.password || '')
  const hasCredentialAttempt = Boolean(username && password)

  let boundAdmin = null
  let credentialAdmin = null
  if (collection.exists && uid) {
    try {
      boundAdmin = await findAdminByOpenid(uid)
    } catch (err) {
      return fail('INTERNAL_ERROR', '查询管理员 openid 失败：' + String((err && (err.errMsg || err.message)) || ''))
    }
  }
  if (collection.exists && hasCredentialAttempt) {
    try {
      credentialAdmin = await findAdminByUsername(username)
    } catch (err) {
      return fail('INTERNAL_ERROR', '查询管理员账号失败：' + String((err && (err.errMsg || err.message)) || ''))
    }
  }

  const plan = core.planWxLogin({
    collectionErrorText: collection.errorText,
    hasUid: Boolean(uid),
    boundAdminFound: Boolean(boundAdmin),
    hasCredentialAttempt: hasCredentialAttempt,
    credentialAdminFound: Boolean(credentialAdmin),
    passwordMatches: credentialAdmin ? security.verifyPassword(password, credentialAdmin.passwordHash) : false,
    collectionExists: collection.exists,
    adminTotal: collection.total,
    hasBootstrap: envs.bootstrap,
    bootstrapMatches: envs.bootstrap && password ? password === envText('ADMIN_BOOTSTRAP_PASSWORD') : false
  })
  if (!plan.ok) return plan

  let admin = boundAdmin
  if (plan.mode === 'bootstrap') {
    if (plan.createCollection) {
      const ensured = await ensureCollection()
      if (!ensured.ok) return fail('ADMINS_COLLECTION_MISSING', ensured.message, ensured.hint)
    }
    const adminId = security.newAdminId()
    const doc = {
      adminId: adminId,
      username: username || 'admin',
      passwordHash: security.hashPassword(password),
      role: 'platform_admin',
      openid: uid,
      openidBoundAt: new Date(),
      createdAt: new Date()
    }
    try {
      await db.collection(ADMINS).doc(adminId).set({ data: doc })
    } catch (err) {
      if (core.isCollectionMissing(err)) return fail('ADMINS_COLLECTION_MISSING')
      return fail('INTERNAL_ERROR', '创建管理员失败：' + String((err && (err.errMsg || err.message)) || ''))
    }
    admin = Object.assign({ _id: adminId }, doc)
  } else if (plan.mode === 'bind') {
    admin = credentialAdmin
    try {
      await bindOpenid(admin, uid)
    } catch (err) {
      return fail('INTERNAL_ERROR', '绑定 openid 失败：' + String((err && (err.errMsg || err.message)) || ''))
    }
  }

  return ok({
    bound: true,
    openid: uid,
    admin: {
      adminId: admin._id || admin.adminId,
      username: admin.username || '',
      role: admin.role || 'platform_admin'
    }
  })
}

async function verify(payload) {
  const result = security.verifyToken(payload.token)
  if (!result.ok) return fail(result.code, result.message)
  return ok({ adminId: result.payload.adminId, username: result.payload.username, exp: result.payload.exp })
}

/**
 * 首屏自检：只返回「有没有 / 数量」，不返回任何变量值与密钥。
 * 顶部 code 固定为 0（这是一次状态汇报，不是错误），逐项检查看 checks。
 */
async function precheck(event) {
  const envs = envState()
  const caller = describeCaller(event)
  const collection = await collectionState()

  const checks = []

  checks.push({
    key: 'function',
    label: '云函数可达',
    ok: true,
    detail: 'adminAuth 已响应',
    hint: ''
  })

  checks.push({
    key: 'anonymous',
    label: '匿名登录态',
    ok: caller.hasUid,
    detail: caller.hasUid ? '已取得访客身份' : '未取得访客身份',
    code: caller.hasUid ? '' : 'ANONYMOUS_REQUIRED',
    hint: caller.hasUid
      ? ''
      : '云开发控制台 → 设置 → 登录方式 → 开启匿名登录，并把当前页面域名加入 Web 安全域名后刷新。'
  })

  checks.push({
    key: 'adminsCollection',
    label: 'admins 集合',
    ok: collection.exists,
    detail: collection.errorText
      ? '查询失败：' + collection.errorText
      : (collection.exists ? '已存在，' + collection.total + ' 条记录' : '不存在'),
    code: collection.exists ? '' : 'ADMINS_COLLECTION_MISSING',
    hint: collection.exists
      ? ''
      : '首次登录时配置了 ADMIN_BOOTSTRAP_PASSWORD 会自动创建；也可在控制台数据库手动新建 admins。'
  })

  checks.push({
    key: 'adminCount',
    label: '管理员数量',
    ok: collection.total > 0,
    detail: collection.total > 0 ? collection.total + ' 个' : '0 个（尚未初始化）',
    code: '',
    hint: collection.total > 0
      ? ''
      : '用初始口令创建第一个管理员：用户名建议 admin，密码填 ADMIN_BOOTSTRAP_PASSWORD 的值。'
  })

  checks.push({
    key: 'bootstrapEnv',
    label: '环境变量 ADMIN_BOOTSTRAP_PASSWORD',
    ok: envs.bootstrap,
    detail: envs.bootstrap ? '已配置' : '未配置',
    code: envs.bootstrap ? '' : 'ENV_MISSING',
    hint: envs.bootstrap
      ? ''
      : '云开发控制台 → 云函数 → adminAuth → 环境变量新增该项；保存后重新部署云函数。'
  })

  checks.push({
    key: 'tokenSecretEnv',
    label: '环境变量 ADMIN_TOKEN_SECRET（≥16 位）',
    ok: envs.tokenSecret,
    detail: envs.tokenSecret ? '已配置' : '未配置或长度不足',
    code: envs.tokenSecret ? '' : 'TOKEN_SECRET_MISSING',
    hint: envs.tokenSecret
      ? ''
      : 'adminAuth 与 adminApi 都要配置同一个 ≥16 位随机字符串；保存后重新部署这两个云函数。'
  })

  return ok({
    serverTime: new Date().toISOString(),
    identity: { hasUid: caller.hasUid, source: caller.source },
    admins: { collectionExists: collection.exists, total: collection.total },
    env: { bootstrapPassword: envs.bootstrap, tokenSecret: envs.tokenSecret },
    checks: checks
  })
}

async function handleCall(event) {
  const action = String((event && event.action) || '')
  const payload = (event && event.payload) || {}
  try {
    if (action === 'login') return await login(payload)
    if (action === 'wxLogin') return await wxLogin(payload, event)
    if (action === 'verify') return await verify(payload)
    if (action === 'precheck' || action === 'diagnose') return await precheck(event)
    return fail('UNKNOWN_ACTION', '未知的管理员认证接口：' + action)
  } catch (err) {
    if (err && err.code) {
      const mapped = core.fail(
        err.code === 'ADMIN_TOKEN_SECRET_MISSING' ? 'TOKEN_SECRET_MISSING' : err.code,
        err.message,
        err.hint
      )
      if (mapped.code && core.ERROR_MAP[mapped.code]) return mapped
    }
    console.error('[adminAuth] 执行失败', err)
    return fail('INTERNAL_ERROR', (err && (err.errMsg || err.message)) || '管理员认证失败')
  }
}

/* ------------------------------ HTTP 访问服务（可选链路 B） ------------------------------ */

function isHttpEvent(event) {
  if (!event) return false
  return Boolean(event.httpMethod || event.requestContext)
}

function headerValue(headers, name) {
  const source = headers || {}
  const target = String(name || '').toLowerCase()
  const key = Object.keys(source).filter((item) => item.toLowerCase() === target)[0]
  return key ? String(source[key] || '') : ''
}

function corsHeaders(event) {
  const origin = headerValue(event && event.headers, 'origin') || '*'
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'content-type,x-admin-token',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=utf-8'
  }
}

async function handleHttp(event) {
  const method = String((event && event.httpMethod) || '').toUpperCase()
  if (method === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(event), body: '' }
  if (method !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(event), body: JSON.stringify(fail('METHOD_NOT_ALLOWED', 'HTTP 访问服务仅支持 POST')) }
  }
  let text = (event && event.body) || ''
  if (event && event.isBase64Encoded) {
    try {
      text = Buffer.from(String(text), 'base64').toString('utf8')
    } catch (err) {
      text = ''
    }
  }
  let body = {}
  if (typeof text === 'string' && text) {
    try {
      body = JSON.parse(text)
    } catch (err) {
      return { statusCode: 400, headers: corsHeaders(event), body: JSON.stringify(fail('BAD_JSON', '请求体必须是 JSON 对象')) }
    }
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { statusCode: 400, headers: corsHeaders(event), body: JSON.stringify(fail('BAD_JSON', '请求体必须是 JSON 对象')) }
  }
  const result = await handleCall({ action: String(body.action || ''), payload: body.payload || {} })
  return { statusCode: 200, headers: corsHeaders(event), body: JSON.stringify(result) }
}

exports.main = async (event) => {
  if (isHttpEvent(event)) return await handleHttp(event)
  return await handleCall(event)
}
