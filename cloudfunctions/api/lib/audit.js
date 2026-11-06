'use strict'

const { COLLECTIONS: COL } = require('../core/collections')

/**
 * 审计日志：只记录「谁、何时、做了什么、对哪个租户、结果」。
 * 禁止写入订单内容、菜品名、顾客信息、金额等业务值。
 */
function buildAuditRecord(input) {
  const src = input || {}
  return {
    actorType: String(src.actorType || 'merchant'),
    actorId: String(src.actorId || ''),
    action: String(src.action || ''),
    merchantId: String(src.merchantId || ''),
    result: src.result === 'fail' ? 'fail' : 'ok',
    code: String(src.code || 'OK'),
    source: String(src.source || 'merchant-console').slice(0, 40),
    at: src.at || new Date()
  }
}

async function writeAudit(db, input) {
  try {
    await db.collection(COL.AUDIT_LOGS).add({ data: buildAuditRecord(input) })
  } catch (err) {
    console.warn('[audit] 写入审计日志失败', err && err.message)
  }
}

/** 错误日志：仅 action / code / merchantId / 时间，不写业务参数值 */
function buildErrorRecord(input) {
  const src = input || {}
  return {
    action: String(src.action || ''),
    code: String(src.code || 'INTERNAL_ERROR'),
    merchantId: String(src.merchantId || ''),
    at: src.at || new Date()
  }
}

async function writeError(db, input) {
  try {
    await db.collection(COL.ERROR_LOGS).add({ data: buildErrorRecord(input) })
  } catch (err) {
    // 错误日志失败不影响主流程
  }
}

module.exports = { buildAuditRecord, writeAudit, buildErrorRecord, writeError }
