'use strict'

/**
 * 自检接口：action = 'health'
 * 只读，不修改任何业务数据；用于「自检」页判断云端是否真正跑通。
 */

const config = require('../config')
const { COLLECTIONS: COL, COLLECTION_LIST } = require('../core/collections')
const dates = require('../core/dates')
const paymode = require('../core/paymode')
const { fail } = require('../core/errors')
const dbLib = require('../lib/db')
const settingsLib = require('../lib/settings')
const menuHandler = require('./menu')

const LABELS = {
  merchants: '商家',
  merchant_staff: '商家员工绑定',
  admins: '平台管理员',
  categories: '菜品分类',
  dishes: '菜品',
  menus: '每日菜单',
  orders: '订单',
  slot_counters: '时段名额计数',
  counters: '订单号计数器',
  merchant_admins: '旧版商家白名单',
  settings: '配置',
  payment_records: '收款记录'
}

function errorText(err) {
  return (err && (err.errMsg || err.message)) || '集合不存在或不可访问'
}

async function health(ctx) {
  // 环境体检只给平台管理员（openid 需在 admins 集合绑定）；商家端不再暴露环境细节
  const identity = ctx.identity || {}
  if (identity.role !== 'admin') fail('FORBIDDEN', '环境体检仅限平台管理员')

  const serverTime = new Date()
  const dateKey = dates.shanghaiDateKey(serverTime)
  const merchantId = identity.merchantId || config.DEFAULT_MERCHANT_ID
  const menuId = menuHandler.menuIdOf(dateKey, merchantId)

  const collections = []
  for (const name of COLLECTION_LIST) {
    try {
      const res = await ctx.db.collection(name).count()
      collections.push({
        name,
        label: LABELS[name] || name,
        exists: true,
        total: (res && res.total) || 0,
        error: '',
        fix: '无需处理'
      })
    } catch (err) {
      collections.push({
        name,
        label: LABELS[name] || name,
        exists: false,
        total: 0,
        error: errorText(err),
        fix: `云开发控制台 → 数据库 → 新建集合「${name}」，或部署 init 云函数并调用 {"action":"setup"}`
      })
    }
  }

  const menu = await dbLib.getDocOrNull(ctx.db, COL.MENUS, menuId)
  const settings = await settingsLib.getPaymentSettings(ctx.db, merchantId)
  const branch = paymode.resolvePayBranch({
    payMode: settings.payMode,
    wxpayEnabled: config.WXPAY.ENABLED,
    subMchId: config.WXPAY.SUB_MCH_ID,
    envId: config.WXPAY.ENV_ID
  })

  const published = !!(menu && menu.published !== false)
  return {
    ok: true,
    mode: 'cloud',
    envId: ctx.envId || '',
    apiVersion: config.API_VERSION,
    serverTimeText: dates.shanghaiDateTime(serverTime),
    openid: ctx.openid || '',
    identity: {
      openid: identity.openid || '',
      role: identity.role || 'customer',
      merchantId,
      merchantName: identity.merchantName || config.SHOP.name,
      merchantStatus: identity.merchantStatus || 'active'
    },
    collections,
    today: {
      date: dateKey,
      dateLabel: dates.shanghaiDateLabel(dateKey),
      menuId,
      menuPublished: published,
      fix: published
        ? '无需处理'
        : '商家后台 → 菜单 → 发布今日菜单；若还没有菜品，先执行 init 云函数 {"action":"setup"}'
    },
    payment: {
      payMode: settings.payMode,
      payModeLabel: paymode.PAY_MODE_LABELS[settings.payMode],
      usable: branch.usable,
      unusableReason: branch.usable ? '' : branch.message || '',
      jsapiConfigured: !!(config.WXPAY.ENABLED && config.WXPAY.SUB_MCH_ID && config.WXPAY.ENV_ID),
      fix: branch.usable ? '无需处理' : '商家端 → 收款设置 → 切回转账 transfer；或先配置 cloudPay 商户号'
    },
    config: {
      defaultMerchantId: config.DEFAULT_MERCHANT_ID,
      merchantId,
      merchantOpenidCount: config.MERCHANT_OPENIDS.length,
      allowAutoBootstrap: config.ALLOW_AUTO_BOOTSTRAP
    },
    note: '若集合列表有失败项：优先执行 init 云函数 {"action":"setup"}，再重新体检'
  }
}

module.exports = { health }
