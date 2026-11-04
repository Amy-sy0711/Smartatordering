'use strict'

/**
 * ============================================================
 * 集中配置：改商家白名单 / 商户号 / 演示开关，只改这一个文件
 * ============================================================
 */

// 单商户固定 ID。订单、菜品都带 merchantId 字段，后续多店时按店铺过滤即可。
const MERCHANT_ID = 'merchant_001'

// 商家 openid 白名单（静态配置，优先级最高）。
// 获取自己的 openid：小程序里「商家入口」页会显示，或部署 cloudfunctions/init 后调用 whoami。
const MERCHANT_OPENIDS = [
  // 'oXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
]

// 演示用：白名单为空时，允许第一个进入「商家入口」的人自助成为商家
// （openid 会写入 merchant_admins 集合）。正式上线前必须：1) 填上面白名单 2) 把这里改为 false
const ALLOW_AUTO_BOOTSTRAP = true

// 下单规则
const MAX_QTY_PER_ITEM = 20   // 同一菜品（同规格）单行最大数量
const MAX_CART_LINES = 30     // 购物车最大行数
const MAX_REMARK_LENGTH = 60  // 备注最大长度
const DEFAULT_SLOT_LIMIT = 20 // 取餐时段默认限量（单数）

// 每天默认发布的取餐时段
const DEFAULT_SLOTS = [
  { id: 's1', label: '11:30-12:00', limit: 20 },
  { id: 's2', label: '12:00-12:30', limit: 20 },
  { id: 's3', label: '12:30-13:00', limit: 20 }
]

// 门店信息（仅用于前端展示）
const SHOP = {
  name: '今日菜单',
  pickupPlace: '店内前台自提',
  pickupNote: '请按所选时段到店内前台报订单号取餐'
}

/**
 * 真实微信支付（cloudPay JSAPI）配置（仅用于前端可用性判断）。
 * 是否使用微信支付由 settings/payment 的 payMode 决定；payMode=jsapi 时本段必须与
 * cloudfunctions/pay/config.js 的 WXPAY 保持一致，否则前端会提示支付未配置。
 * 密钥/证书不要写进代码，cloudPay 由云开发托管商户号与证书（只在控制台配置）。
 */
const WXPAY = {
  ENABLED: false,
  SUB_MCH_ID: '',   // 子商户号（服务商模式）；直连商户可不填，按控制台要求填
  ENV_ID: '',       // 云开发环境 ID（cloudPay 回调目标环境）
  BODY_PREFIX: '点餐' // 支付账单标题前缀
}

module.exports = {
  MERCHANT_ID,
  MERCHANT_OPENIDS,
  ALLOW_AUTO_BOOTSTRAP,
  MAX_QTY_PER_ITEM,
  MAX_CART_LINES,
  MAX_REMARK_LENGTH,
  DEFAULT_SLOT_LIMIT,
  DEFAULT_SLOTS,
  SHOP,
  WXPAY
}
