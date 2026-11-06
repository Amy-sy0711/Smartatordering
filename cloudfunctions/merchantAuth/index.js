'use strict'

const cloud = require('wx-server-sdk')
const security = require('./core/security')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const MERCHANTS = 'merchants'

function ok(data) {
  return { code: 0, data }
}

function fail(code, message) {
  return { code, message }
}

async function findMerchantByUsername(username) {
  const byLogin = await db.collection(MERCHANTS).where({ loginUsername: username }).limit(1).get()
    .catch(() => ({ data: [] }))
  if (byLogin && byLogin.data && byLogin.data[0]) return byLogin.data[0]
  // 兼容：用户名也可以直接填 merchantId
  try {
    const res = await db.collection(MERCHANTS).doc(username).get()
    return (res && res.data) || null
  } catch (err) {
    return null
  }
}

async function login(payload) {
  const username = String(payload.username || '').trim()
  const password = String(payload.password || '')
  if (!username || username.length > 64) return fail('USERNAME_INVALID', '商家账号需为 1-64 个字符')
  if (!password) return fail('PASSWORD_REQUIRED', '请输入密码')

  const merchant = await findMerchantByUsername(username)
  if (!merchant) return fail('LOGIN_FAILED', '商家账号或密码错误')
  if (merchant.status === 'disabled') return fail('MERCHANT_DISABLED', '商家已停用，请联系平台管理员')
  if (!merchant.passwordHash) return fail('LOGIN_FAILED', '该商家尚未初始化网页后台密码，请联系平台管理员重置')

  if (!security.verifyPassword(password, merchant.passwordHash)) {
    return fail('LOGIN_FAILED', '商家账号或密码错误')
  }

  const merchantId = merchant._id || merchant.merchantId
  const token = security.signMerchantToken({
    merchantId,
    role: 'owner',
    username: merchant.loginUsername || merchantId
  })
  return ok({
    token,
    merchant: {
      merchantId,
      name: merchant.name || '',
      status: merchant.status || 'active',
      username: merchant.loginUsername || merchantId
    }
  })
}

async function verify(payload) {
  const result = security.verifyMerchantToken(payload.token)
  if (!result.ok) return fail(result.code, result.message)
  const merchantId = result.payload.merchantId
  let merchant = null
  try {
    const res = await db.collection(MERCHANTS).doc(merchantId).get()
    merchant = (res && res.data) || null
  } catch (err) {
    merchant = null
  }
  if (!merchant) return fail('MERCHANT_NOT_FOUND', '商家不存在或已删除')
  if (merchant.status === 'disabled') return fail('MERCHANT_DISABLED', '商家已停用')
  return ok({
    merchantId,
    name: merchant.name || '',
    status: merchant.status || 'active',
    exp: result.payload.exp
  })
}

exports.main = async (event) => {
  const action = String((event && event.action) || '')
  const payload = (event && event.payload) || {}
  try {
    if (action === 'login') return await login(payload)
    if (action === 'verify') return await verify(payload)
    return fail('UNKNOWN_ACTION', '未知的商家认证接口：' + action)
  } catch (err) {
    if (err && err.code) return fail(err.code, err.message)
    console.error('[merchantAuth] 执行失败', err)
    return fail('INTERNAL_ERROR', (err && err.message) || '商家认证失败')
  }
}
