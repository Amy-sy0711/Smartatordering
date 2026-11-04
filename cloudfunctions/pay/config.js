'use strict'

/**
 * ============================================================
 * 支付云函数配置（与 cloudfunctions/api/config.js 的 WXPAY 段保持一致）
 * 密钥/证书不要写进代码：cloudPay 的商户号与证书在云开发控制台配置。
 * ============================================================
 */
const WXPAY = {
  ENABLED: false,
  SUB_MCH_ID: '',   // 子商户号（服务商模式）；按控制台实际配置填写
  ENV_ID: '',       // 云开发环境 ID（支付回调指向的环境）
  BODY_PREFIX: '点餐'
}

const COLLECTIONS = {
  ORDERS: 'orders',
  SETTINGS: 'settings',
  PAYMENT_RECORDS: 'payment_records'
}

module.exports = { WXPAY, COLLECTIONS }
