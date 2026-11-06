'use strict'

/**
 * 商家管理台 token：HMAC-SHA256，密钥来自云函数环境变量，禁止写死。
 * 优先 MERCHANT_TOKEN_SECRET；未配置时兼容复用 ADMIN_TOKEN_SECRET（同一部署环境）。
 */

const crypto = require('crypto')

function tokenSecret() {
  const secret = String(process.env.MERCHANT_TOKEN_SECRET || process.env.ADMIN_TOKEN_SECRET || '')
  if (secret.length < 16) {
    const err = new Error('服务端未配置 MERCHANT_TOKEN_SECRET（至少 16 位）')
    err.code = 'MERCHANT_TOKEN_SECRET_MISSING'
    throw err
  }
  return secret
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function signMerchantToken(payload) {
  const body = Object.assign({ typ: 'merchant' }, payload || {})
  if (!body.exp) body.exp = Date.now() + 12 * 3600 * 1000
  body.issuedAt = body.issuedAt || Date.now()
  const data = base64url(JSON.stringify(body))
  const sig = base64url(crypto.createHmac('sha256', tokenSecret()).update(data).digest())
  return data + '.' + sig
}

function verifyMerchantToken(token) {
  const raw = String(token || '')
  const parts = raw.split('.')
  if (parts.length !== 2) return { ok: false, code: 'TOKEN_INVALID', message: '登录凭证格式不正确' }
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
  if (!payload || payload.typ !== 'merchant' || !payload.merchantId || !payload.exp) {
    return { ok: false, code: 'TOKEN_INVALID', message: '登录凭证缺少必要字段' }
  }
  if (Number(payload.exp) <= Date.now()) {
    return { ok: false, code: 'TOKEN_EXPIRED', message: '登录已过期，请重新登录' }
  }
  return { ok: true, payload }
}

module.exports = { tokenSecret, signMerchantToken, verifyMerchantToken }
