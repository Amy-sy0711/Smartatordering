'use strict'

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const router = require('./router')
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
    payload
  }

  try {
    const data = await handler(ctx)
    return { code: 0, data: data === undefined ? null : data }
  } catch (err) {
    if (isAppError(err)) return { code: err.code, message: err.message }
    console.error('[api] ' + action + ' 执行失败', err)
    return { code: 'INTERNAL_ERROR', message: (err && err.message) || '服务异常，请稍后再试' }
  }
}
