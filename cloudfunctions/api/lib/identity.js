'use strict'

const config = require('../config')
const { COLLECTIONS: COL } = require('../core/collections')
const identityCore = require('../core/identity')
const merchantToken = require('../core/merchant-token')
const { fail } = require('../core/errors')
const { getDocOrNull } = require('./db')

async function getStaffDoc(db, openid) {
  if (!openid) return null
  return getDocOrNull(db, COL.MERCHANT_STAFF, openid)
}

async function getMerchantDoc(db, merchantId) {
  if (!merchantId) return null
  return getDocOrNull(db, COL.MERCHANTS, merchantId)
}

async function isPlatformAdmin(db, openid) {
  if (!openid) return false
  try {
    const res = await db.collection(COL.ADMINS).where({ openid }).limit(1).get()
    return !!(res && res.data && res.data.length)
  } catch (err) {
    return false
  }
}

/**
 * 统一身份解析：商家员工关系优先，其次平台管理员，再次静态白名单，最后顾客。
 * 商家写操作永远以 merchant_staff 记录的 merchantId 为准，不信任前端传值。
 */
async function resolveIdentity(ctx) {
  const payload = ctx.payload || {}
  const requested = payload.merchantId || payload.mid

  // 商家网页后台：用 token 身份（openid 为空，不能只信前端传的 merchantId）
  if (payload.token) {
    return resolveTokenIdentity(ctx, payload.token)
  }

  const staffDoc = await getStaffDoc(ctx.db, ctx.openid)
  const isAdmin = await isPlatformAdmin(ctx.db, ctx.openid)
  const isStaticMerchant =
    !!ctx.openid && config.MERCHANT_OPENIDS.indexOf(ctx.openid) >= 0

  const classified = identityCore.classifyIdentity({
    openid: ctx.openid,
    staffDoc,
    isAdmin,
    isStaticMerchant,
    requestedMerchantId: requested,
    defaultMerchantId: config.DEFAULT_MERCHANT_ID
  })
  const merchant = await getMerchantDoc(ctx.db, classified.merchantId)
  const merchantStatus = identityCore.merchantStatusOf(
    merchant,
    classified.merchantId,
    config.DEFAULT_MERCHANT_ID
  )

  return {
    openid: classified.openid,
    role: classified.role,
    merchantId: classified.merchantId,
    merchantName: (merchant && merchant.name) || config.SHOP.name,
    merchantStatus,
    merchantFlags: (merchant && merchant.flags) || {},
    merchantIds: classified.merchantIds,
    isMerchant: identityCore.isMerchantRole(classified.role)
  }
}

/**
 * 商家后台 token 身份：merchantId 只从 token 取，绝不采用前端传入值。
 * 商家被停用、token 被吊销（tokenRevokedAt 晚于签发时间）都直接拒绝。
 */
async function resolveTokenIdentity(ctx, token) {
  const result = merchantToken.verifyMerchantToken(token)
  if (!result.ok) fail(result.code, result.message)
  const payload = result.payload
  const merchantId = identityCore.normalizeMerchantId(payload.merchantId)
  if (!merchantId) fail('TOKEN_INVALID', '登录凭证中的商家 ID 不合法')

  const merchant = await getMerchantDoc(ctx.db, merchantId)
  if (!merchant) fail('MERCHANT_NOT_FOUND', '商家不存在或已被删除')
  if (payload.issuedAt && merchant.tokenRevokedAt && Number(payload.issuedAt) < new Date(merchant.tokenRevokedAt).getTime()) {
    fail('TOKEN_REVOKED', '登录凭证已被吊销，请重新登录')
  }
  if (merchant.status === 'disabled') fail('MERCHANT_DISABLED', '商家已停用，请联系平台管理员')

  return {
    openid: '',
    role: 'owner',
    merchantId,
    merchantName: merchant.name || '',
    merchantStatus: 'active',
    merchantFlags: merchant.flags || {},
    merchantIds: Array.isArray(merchant.merchantIds) ? merchant.merchantIds.slice() : [merchantId],
    isMerchant: true,
    authType: 'merchant-token'
  }
}

/** 商家端接口守卫：写操作校验角色 + 商家状态 + ownerOnly */
async function requireMerchant(ctx, options) {
  const identity = ctx.identity || await resolveIdentity(ctx)
  const decision = identityCore.decideMerchantAccess(identity, options)
  if (!decision.allowed) fail(decision.code, decision.message)
  return identity
}

/** 商家端 merchantId（写操作不读取前端传值） */
function merchantIdOf(identity) {
  return (identity && identity.merchantId) || config.DEFAULT_MERCHANT_ID
}

module.exports = {
  resolveIdentity,
  requireMerchant,
  merchantIdOf,
  getMerchantDoc,
  getStaffDoc
}
