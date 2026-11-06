'use strict'

const cloud = require('wx-server-sdk')
const security = require('./core/security')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const ADMINS = 'admins'

function ok(data) {
  return { code: 0, data }
}

function fail(code, message) {
  return { code, message }
}

async function countAdmins() {
  const res = await db.collection(ADMINS).count()
  return (res && res.total) || 0
}

async function findAdminByUsername(username) {
  const res = await db.collection(ADMINS).where({ username }).limit(1).get()
  return (res && res.data && res.data[0]) || null
}

/**
 * 登录：
 *  - 已有管理员：校验用户名 + scrypt 密码
 *  - 集合为空：允许用环境变量 ADMIN_BOOTSTRAP_PASSWORD 创建第一个管理员（一次性）
 */
async function login(payload) {
  const username = String(payload.username || '').trim()
  const password = String(payload.password || '')
  if (!username || username.length > 32) return fail('USERNAME_INVALID', '用户名需为 1-32 个字符')
  if (!password) return fail('PASSWORD_REQUIRED', '请输入密码')

  let admin = await findAdminByUsername(username)
  if (!admin) {
    const total = await countAdmins()
    if (total > 0) return fail('LOGIN_FAILED', '用户名或密码错误')
    const bootstrap = String(process.env.ADMIN_BOOTSTRAP_PASSWORD || '')
    if (!bootstrap) {
      return fail('BOOTSTRAP_DISABLED', '还没有管理员，请先在云函数环境变量配置 ADMIN_BOOTSTRAP_PASSWORD 再登录')
    }
    if (password !== bootstrap) return fail('LOGIN_FAILED', '初始口令不正确')
    const adminId = security.newAdminId()
    const doc = {
      adminId,
      username,
      passwordHash: security.hashPassword(password),
      role: 'platform_admin',
      createdAt: new Date()
    }
    await db.collection(ADMINS).doc(adminId).set({ data: doc })
    admin = Object.assign({ _id: adminId }, doc)
  } else if (!security.verifyPassword(password, admin.passwordHash)) {
    return fail('LOGIN_FAILED', '用户名或密码错误')
  }

  const token = security.signToken({ adminId: admin._id || admin.adminId, username: admin.username })
  return ok({
    token,
    admin: { adminId: admin._id || admin.adminId, username: admin.username }
  })
}

async function verify(payload) {
  const result = security.verifyToken(payload.token)
  if (!result.ok) return fail(result.code, result.message)
  return ok({ adminId: result.payload.adminId, username: result.payload.username, exp: result.payload.exp })
}

exports.main = async (event) => {
  const action = String((event && event.action) || '')
  const payload = (event && event.payload) || {}
  try {
    if (action === 'login') return await login(payload)
    if (action === 'verify') return await verify(payload)
    return fail('UNKNOWN_ACTION', '未知的管理员认证接口：' + action)
  } catch (err) {
    if (err && err.code === 'ADMIN_TOKEN_SECRET_MISSING') return fail(err.code, err.message)
    console.error('[adminAuth] 执行失败', err)
    return fail('INTERNAL_ERROR', (err && err.message) || '管理员认证失败')
  }
}
