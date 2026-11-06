'use strict'

const crypto = require('crypto')

const HASH_PREFIX = 'scrypt'
const DEFAULT_TTL_HOURS = 12

function tokenSecret() {
  const secret = String(process.env.ADMIN_TOKEN_SECRET || '')
  if (secret.length < 16) {
    const err = new Error('服务端未配置 ADMIN_TOKEN_SECRET（至少 16 位），请在云函数环境变量中设置')
    err.code = 'ADMIN_TOKEN_SECRET_MISSING'
    throw err
  }
  return secret
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function signToken(payload) {
  const body = Object.assign({}, payload)
  if (!body.exp) {
    const hours = Number(process.env.ADMIN_TOKEN_TTL_HOURS) || DEFAULT_TTL_HOURS
    body.exp = Date.now() + hours * 3600 * 1000
  }
  body.issuedAt = body.issuedAt || Date.now()
  const data = base64url(JSON.stringify(body))
  const sig = base64url(crypto.createHmac('sha256', tokenSecret()).update(data).digest())
  return data + '.' + sig
}

function verifyToken(token) {
  const raw = String(token || '')
  const parts = raw.split('.')
  if (parts.length !== 2) {
    return { ok: false, code: 'TOKEN_INVALID', message: '登录凭证格式不正确' }
  }
  const expected = base64url(crypto.createHmac('sha256', tokenSecret()).update(parts[0]).digest())
  const given = parts[1]
  const a = Buffer.from(expected)
  const b = Buffer.from(given)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, code: 'TOKEN_FORGED', message: '登录凭证无效，请重新登录' }
  }
  let payload = null
  try {
    payload = JSON.parse(Buffer.from(parts[0].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
  } catch (err) {
    return { ok: false, code: 'TOKEN_INVALID', message: '登录凭证损坏，请重新登录' }
  }
  if (!payload || !payload.adminId || !payload.exp) {
    return { ok: false, code: 'TOKEN_INVALID', message: '登录凭证缺少必要字段' }
  }
  if (Number(payload.exp) <= Date.now()) {
    return { ok: false, code: 'TOKEN_EXPIRED', message: '登录已过期，请重新登录' }
  }
  return { ok: true, payload }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex')
  return HASH_PREFIX + '$' + salt + '$' + hash
}

function verifyPassword(password, stored) {
  const raw = String(stored || '')
  const parts = raw.split('$')
  if (parts.length !== 3 || parts[0] !== HASH_PREFIX) return false
  const salt = parts[1]
  const expected = Buffer.from(parts[2], 'hex')
  let given = null
  try {
    given = crypto.scryptSync(String(password), salt, expected.length)
  } catch (err) {
    return false
  }
  if (given.length !== expected.length) return false
  return crypto.timingSafeEqual(given, expected)
}

function newAdminId() {
  return 'admin_' + crypto.randomBytes(8).toString('hex')
}

module.exports = { tokenSecret, signToken, verifyToken, hashPassword, verifyPassword, newAdminId }
