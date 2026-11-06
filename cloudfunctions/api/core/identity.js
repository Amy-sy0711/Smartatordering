'use strict'

/**
 * 多租户身份与权限的纯逻辑（不依赖数据库，可离线单测）。
 *
 * 角色：
 *  - admin    平台管理员（admins 集合中绑定了 openid，或管理台 token 用户）
 *  - owner    商家店主（merchant_staff.role = owner）
 *  - staff    商家员工（merchant_staff.role = staff）
 *  - customer 普通顾客
 */

const MERCHANT_ROLES = ['admin', 'owner', 'staff']

function normalizeMerchantId(raw) {
  const value = String(raw || '').trim()
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : ''
}

/**
 * 根据数据库线索判定角色。
 * @param {Object} input
 * @param {Object|null} input.staffDoc     merchant_staff 文档（_id = openid）
 * @param {boolean} input.isAdmin          是否在 admins 集合中绑定
 * @param {boolean} input.isStaticMerchant  是否命中 config.MERCHANT_OPENIDS
 * @param {string} input.openid
 * @param {string} input.defaultMerchantId
 * @param {string} input.requestedMerchantId 顾客从分享卡片带来的 mid
 */
function classifyIdentity(input) {
  const src = input || {}
  const staff = src.staffDoc || null
  const openid = String(src.openid || '')
  const requested = normalizeMerchantId(src.requestedMerchantId)
  const defaultMerchantId = normalizeMerchantId(src.defaultMerchantId)

  if (staff && staff.merchantId) {
    return {
      openid,
      role: staff.role === 'owner' ? 'owner' : 'staff',
      merchantId: normalizeMerchantId(staff.merchantId) || defaultMerchantId,
      merchantIds: Array.isArray(staff.merchantIds) ? staff.merchantIds.slice() : []
    }
  }
  if (src.isAdmin === true) {
    return {
      openid,
      role: 'admin',
      merchantId: requested || defaultMerchantId,
      merchantIds: []
    }
  }
  if (src.isStaticMerchant === true && openid) {
    return { openid, role: 'owner', merchantId: defaultMerchantId, merchantIds: [] }
  }
  return {
    openid,
    role: 'customer',
    merchantId: requested || defaultMerchantId,
    merchantIds: []
  }
}

function isMerchantRole(role) {
  return MERCHANT_ROLES.indexOf(role) >= 0
}

/** 商家状态：没有商家文档时，默认商家视为 active，其余视为 disabled（防止误建租户） */
function merchantStatusOf(merchantDoc, merchantId, defaultMerchantId) {
  if (merchantDoc && merchantDoc.status) {
    return merchantDoc.status === 'disabled' ? 'disabled' : 'active'
  }
  return merchantId === defaultMerchantId ? 'active' : 'disabled'
}

/**
 * 商家操作权限。
 * @param {Object} identity
 * @param {Object} options { write, ownerOnly }
 * @returns {{allowed:boolean, code:string, message:string}}
 */
function decideMerchantAccess(identity, options) {
  const src = identity || {}
  const opts = options || {}
  const role = String(src.role || 'customer')
  if (!isMerchantRole(role)) {
    return { allowed: false, code: 'NO_MERCHANT_ACCESS', message: '当前账号不是商家，无法进入商家端' }
  }
  if (opts.write && src.merchantStatus === 'disabled') {
    return { allowed: false, code: 'MERCHANT_DISABLED', message: '商家已停用，暂不能操作' }
  }
  if (opts.ownerOnly && role !== 'owner' && role !== 'admin') {
    return { allowed: false, code: 'ROLE_FORBIDDEN', message: '只有店主可以执行该操作' }
  }
  return { allowed: true, code: 'OK', message: '' }
}

/** 顾客下单前校验商家状态 */
function canCreateOrder(identity) {
  if (!identity || !identity.merchantId) {
    return { allowed: false, code: 'MERCHANT_REQUIRED', message: '请从商家分享的链接进入' }
  }
  if (identity.merchantStatus === 'disabled') {
    return { allowed: false, code: 'MERCHANT_DISABLED', message: '该商家已暂停接单，请稍后再试' }
  }
  return { allowed: true, code: 'OK', message: '' }
}

/** 订单归属校验：买家本人，或该商家员工/管理员 */
function canAccessOrder(identity, order) {
  const src = identity || {}
  const doc = order || {}
  if (doc.buyerOpenid && doc.buyerOpenid === src.openid) return true
  if (!isMerchantRole(src.role)) return false
  return !!src.merchantId && src.merchantId === doc.merchantId
}

module.exports = {
  MERCHANT_ROLES,
  normalizeMerchantId,
  classifyIdentity,
  isMerchantRole,
  merchantStatusOf,
  decideMerchantAccess,
  canCreateOrder,
  canAccessOrder
}
