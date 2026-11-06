'use strict'

/**
 * 自检接口：action = 'health'
 * 只读，不修改任何业务数据；用于「自检」页判断云端是否真正跑通。
 */

const config = require('../config')
const { COLLECTIONS: COL, COLLECTION_LIST } = require('../core/collections')
const dates = require('../core/dates')
const paymode = require('../core/paymode')
const dbLib = require('../lib/db')
const settingsLib = require('../lib/settings')
const menuHandler = require('./menu')
const merchantHandler = require('./merchant')

const LABELS = {
  dishes: '菜品',
  menus: '每日菜单',
  orders: '订单',
  slot_counters: '时段名额计数',
  counters: '订单号计数器',
  merchant_admins: '商家白名单',
  settings: '配置',
  payment_records: '收款记录'
}

function errorText(err) {
  return (err && (err.errMsg || err.message)) || '集合不存在或不可访问'
}

async function health(ctx) {
  const serverTime = new Date()
  const dateKey = dates.shanghaiDateKey(serverTime)
  const menuId = menuHandler.menuIdOf(dateKey)

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
  const settings = await settingsLib.getPaymentSettings(ctx.db)
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
    serverTimeText: dates.shanghaiDateTime(serverTime),
    openid: ctx.openid || '',
    identity: await merchantHandler.whoami(ctx),
    collections,
    today: {
      date: dateKey,
      dateLabel: dates.shanghaiDateLabel(dateKey),
      menuId,
      menuPublished: published,
      menuTitle: (menu && menu.title) || '',
      dishCount: menu && Array.isArray(menu.dishIds) ? menu.dishIds.length : 0,
      fix: published
        ? '无需处理'
        : '进入商家看板 → 菜单管理 → 发布今日菜单；若还没有菜品，先执行 init 云函数 {"action":"setup"}'
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
      merchantId: config.MERCHANT_ID,
      merchantOpenidCount: config.MERCHANT_OPENIDS.length,
      allowAutoBootstrap: config.ALLOW_AUTO_BOOTSTRAP
    },
    note: '若集合列表有失败项：优先执行 init 云函数 {"action":"setup"}，再重新自检'
  }
}

module.exports = { health }
