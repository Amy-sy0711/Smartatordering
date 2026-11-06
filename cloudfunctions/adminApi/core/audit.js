'use strict'

/**
 * 平台审计记录构造（纯逻辑，可离线单测）。
 * 字段固定且不含任何业务字段值：操作者、时间、action、目标 merchantId、结果、错误码、来源。
 */

function buildAuditRecord(admin, action, input, result) {
  const actor = admin || {}
  const src = input || {}
  const res = result || {}
  return {
    actorType: 'platform_admin',
    actorId: String(actor.adminId || actor._id || ''),
    actorName: String(actor.username || '').slice(0, 32),
    action: String(action || ''),
    merchantId: String(src.merchantId || ''),
    result: res.ok === false ? 'fail' : 'ok',
    code: String(res.code || 'OK'),
    source: String(src.source || 'admin-console').slice(0, 40),
    at: new Date()
  }
}

module.exports = { buildAuditRecord }
