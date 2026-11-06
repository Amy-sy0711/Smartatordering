'use strict'

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const router = require('./router')
const identityLib = require('./lib/identity')
const policy = require('./core/action-policy')
const audit = require('./lib/audit')
const { isAppError } = require('./core/errors')

/**
 * 唯一业务云函数入口。
 * 入参：{ action: 'order.create', payload: {...} }
 * 出参：{ code: 0, data } 或 { code: 'XXX', message }
 */
exports.main = async (event) => {
  const action = String((event && event.action) || '')
  const payload = (event && event.payload) || {}
  const wxContext = cloud.getWXContext()
  const handler = router[action]

  if (!handler) {
    return { code: 'UNKNOWN_ACTION', message: '未知的接口：' + action }
  }

  const ctx = {
    db,
    _: db.command,
    cloud,
    openid: wxContext.OPENID || '',
    appid: wxContext.APPID || '',
    envId: wxContext.ENV || process.env.TCB_ENV || '',
    payload
  }

  let identity = null
  try {
    // 每次调用统一解析身份（角色 + 当前商家）；商家写操作在 handler 内以该 merchantId 为准
    identity = await identityLib.resolveIdentity(ctx)
    ctx.identity = identity

    // 四类角色 action 白名单：越权直接拒绝并记录（不进入 handler）
    const decision = policy.decideInvoke(identity.role, action)
    if (!decision.allowed) {
      await audit.writeError(db, { action, code: decision.code, merchantId: identity.merchantId })
      return { code: decision.code, message: decision.message }
    }

    const data = await handler(ctx)
    return { code: 0, data: data === undefined ? null : data }
  } catch (err) {
    if (isAppError(err)) {
      await audit.writeError(db, {
        action,
        code: err.code,
        merchantId: (identity && identity.merchantId) || payload.merchantId || ''
      })
      return { code: err.code, message: err.message }
    }
    console.error('[api] ' + action + ' 执行失败', err)
    await audit.writeError(db, {
      action,
      code: 'INTERNAL_ERROR',
      merchantId: (identity && identity.merchantId) || payload.merchantId || ''
    })
    return { code: 'INTERNAL_ERROR', message: (err && err.message) || '服务异常，请稍后再试' }
  }
}
