'use strict'

/**
 * 统一业务错误：code 用大写下划线常量，前端可直接根据 code 做分支。
 * 不依赖 wx-server-sdk，可被 Node 离线单测直接 require。
 * 注意：本文件与 cloudfunctions/pay/core/errors.js 必须保持一致（静态校验会比对）。
 */
class AppError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'AppError'
    this.code = code
  }
}

function fail(code, message) {
  throw new AppError(code, message)
}

function isAppError(err) {
  return !!err && err.name === 'AppError' && typeof err.code === 'string'
}

module.exports = { AppError, fail, isAppError }
