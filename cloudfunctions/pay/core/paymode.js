'use strict'

const { fail } = require('./errors')

/**
 * 支付方式（可配置）：
 *  - transfer：群转账/线下收款（默认）。下单后订单为待付款，顾客转账后点「我已转账」→ pending_confirm，商家确认收款后才算 paid
 *  - jsapi：小程序内微信支付（cloudPay unifiedOrder + 支付回调云函数）
 *  - mock：仅开发调试用的模拟支付，直接把订单置为 paid
 */
const PAY_MODES = {
  TRANSFER: 'transfer',
  JSAPI: 'jsapi',
  MOCK: 'mock'
}

const PAY_MODE_LABELS = {
  transfer: '群转账 / 线下收款',
  jsapi: '小程序内微信支付',
  mock: '模拟支付（仅开发调试）'
}

const DEFAULT_TRANSFER_TIP = '转账后请点「我已转账」，商家确认收款后开始备餐'

const DEFAULT_PAYMENT_SETTINGS = {
  payMode: PAY_MODES.TRANSFER,
  transfer: {
    qrImageUrl: '',
    payeeName: '',
    tipText: DEFAULT_TRANSFER_TIP
  }
}

function isPayMode(mode) {
  return !!PAY_MODE_LABELS[mode]
}

function normalizePayMode(mode) {
  return isPayMode(mode) ? mode : PAY_MODES.TRANSFER
}

function normalizeText(value, fallback, maxLength) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return trimmed.slice(0, maxLength || 200)
}

/** 把 settings 集合里的 payment 文档（可能缺失/脏数据）标准化成前端可直接渲染的结构 */
function normalizePaymentSettings(raw) {
  const doc = raw || {}
  const transferRaw = doc.transfer || {}
  return {
    payMode: normalizePayMode(doc.payMode),
    transfer: {
      qrImageUrl: normalizeText(transferRaw.qrImageUrl, '', 400),
      payeeName: normalizeText(transferRaw.payeeName, '', 40),
      tipText: normalizeText(transferRaw.tipText, DEFAULT_TRANSFER_TIP, 200)
    },
    updatedAt: doc.updatedAt || null,
    updatedBy: doc.updatedBy || ''
  }
}

/**
 * 判断当前配置是否真的可用（纯函数，便于单测）。
 * @returns {{mode, usable, code?, message?, label}}
 */
function resolvePayBranch(options) {
  const opts = options || {}
  const mode = normalizePayMode(opts.payMode)
  const label = PAY_MODE_LABELS[mode]

  if (mode === PAY_MODES.MOCK) {
    return { mode, usable: true, label }
  }
  if (mode === PAY_MODES.TRANSFER) {
    return { mode, usable: true, label }
  }
  // jsapi：必须同时具备商户号（subMchId）、云开发环境 ID，并打开开关
  const configured = !!(opts.wxpayEnabled && opts.subMchId && opts.envId)
  if (!configured) {
    return {
      mode,
      usable: false,
      label,
      code: 'WXPAY_NOT_CONFIGURED',
      message: '小程序内微信支付尚未配置商户号（mchid/subMchId）与云开发环境 ID，请联系商家改用转账收款'
    }
  }
  return { mode, usable: true, label }
}

/** 支付前统一校验：不可用则抛出明确错误，前端直接弹窗提示，不会白屏 */
function assertPayBranchUsable(branch) {
  if (!branch || !branch.usable) {
    fail((branch && branch.code) || 'PAY_MODE_UNUSABLE', (branch && branch.message) || '当前收款方式不可用')
  }
  return branch
}

module.exports = {
  PAY_MODES,
  PAY_MODE_LABELS,
  DEFAULT_PAYMENT_SETTINGS,
  DEFAULT_TRANSFER_TIP,
  isPayMode,
  normalizePayMode,
  normalizePaymentSettings,
  resolvePayBranch,
  assertPayBranchUsable
}
