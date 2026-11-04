'use strict'

const config = require('../config')
const { COLLECTIONS: COL } = require('../core/collections')
const { fail } = require('../core/errors')
const { getDocOrNull } = require('./db')

const ADMIN_DOC_ID = 'merchant_admins'

async function getDynamicOpenids(db) {
  const doc = await getDocOrNull(db, COL.ADMINS, ADMIN_DOC_ID)
  return doc && Array.isArray(doc.openids) ? doc.openids.map(String) : []
}

/** 是否商家：静态白名单（config.js）优先，其次动态白名单（merchant_admins 集合） */
async function isMerchant(db, openid) {
  if (!openid) return false
  if (config.MERCHANT_OPENIDS.indexOf(openid) >= 0) return true
  const dynamic = await getDynamicOpenids(db)
  return dynamic.indexOf(openid) >= 0
}

function bootstrapAllowed() {
  return config.ALLOW_AUTO_BOOTSTRAP && config.MERCHANT_OPENIDS.length === 0
}

async function addDynamicOpenid(db, _, openid) {
  const doc = await getDocOrNull(db, COL.ADMINS, ADMIN_DOC_ID)
  if (doc) {
    if ((doc.openids || []).indexOf(openid) >= 0) return
    await db.collection(COL.ADMINS).doc(ADMIN_DOC_ID).update({ data: { openids: _.addToSet(openid), updatedAt: new Date() } })
    return
  }
  try {
    await db.collection(COL.ADMINS).doc(ADMIN_DOC_ID).set({
      data: { openids: [openid], createdAt: new Date(), updatedAt: new Date() }
    })
  } catch (err) {
    // 并发下已被别的请求创建，退化为数组追加
    await db.collection(COL.ADMINS).doc(ADMIN_DOC_ID).update({ data: { openids: _.addToSet(openid), updatedAt: new Date() } })
  }
}

/**
 * 商家权限校验：非白名单一律拒绝。
 * 演示模式（白名单为空且 ALLOW_AUTO_BOOTSTRAP=true）下允许第一个使用者自助成为商家。
 */
async function ensureMerchant(db, _, openid) {
  if (!openid) fail('NO_OPENID', '未获取到用户身份，请在小程序内使用')
  if (await isMerchant(db, openid)) return { bootstrapped: false }
  if (!bootstrapAllowed()) {
    fail('MERCHANT_FORBIDDEN', '当前账号不是商家账号，请联系店主把你的 openid 加入白名单')
  }
  const dynamic = await getDynamicOpenids(db)
  if (dynamic.length > 0) {
    fail('MERCHANT_FORBIDDEN', '商家已被占用，请联系店主把你的 openid 加入白名单')
  }
  await addDynamicOpenid(db, _, openid)
  return { bootstrapped: true }
}

module.exports = { ADMIN_DOC_ID, getDynamicOpenids, isMerchant, ensureMerchant, bootstrapAllowed, addDynamicOpenid }
