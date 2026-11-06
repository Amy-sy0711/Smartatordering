'use strict'

const config = require('../config')
const { COLLECTIONS: COL } = require('../core/collections')
const dates = require('../core/dates')
const money = require('../core/money')
const slotsCore = require('../core/slots')
const paymode = require('../core/paymode')
const dbLib = require('../lib/db')
const slotLib = require('../lib/slots')
const settingsLib = require('../lib/settings')
const tenant = require('../core/tenant')
const categoriesCore = require('../core/categories')

/** 菜单文档 ID：默认商家沿用旧 ID（m_YYYYMMDD），其他商家加前缀，避免跨租户覆盖 */
function menuIdOf(dateKey, merchantId) {
  return tenant.menuIdOf(dateKey, merchantId)
}

/** 菜品对前端的展示结构（不含成本等内部字段） */
function dishView(dish) {
  return {
    _id: dish._id,
    name: dish.name,
    category: dish.category || '其他',
    priceCents: dish.priceCents,
    priceText: money.formatCents(dish.priceCents),
    imageUrl: dish.imageUrl || '',
    initial: String(dish.name || '菜').slice(0, 1),
    soldOut: dish.soldOut === true,
    onSale: dish.onSale !== false,
    sortOrder: Number.isInteger(dish.sortOrder) ? dish.sortOrder : 0,
    specs: (dish.specs || []).map((group) => ({
      id: String(group.id),
      name: group.name,
      required: group.required !== false,
      options: (group.options || []).map((option) => ({
        id: String(option.id),
        label: option.label,
        priceDeltaCents: Number.isInteger(option.priceDeltaCents) ? option.priceDeltaCents : 0
      }))
    }))
  }
}

/** 支付配置（下发给前端渲染结算按钮与转账信息），按商家隔离 */
async function paymentInfo(db, merchantId) {
  const settings = await settingsLib.getPaymentSettings(db, merchantId)
  const branch = paymode.resolvePayBranch({
    payMode: settings.payMode,
    wxpayEnabled: config.WXPAY.ENABLED,
    subMchId: config.WXPAY.SUB_MCH_ID,
    envId: config.WXPAY.ENV_ID
  })
  return {
    payMode: settings.payMode,
    payModeLabel: paymode.PAY_MODE_LABELS[settings.payMode],
    transfer: settings.transfer,
    usable: branch.usable,
    unusableReason: branch.usable ? '' : branch.message || '',
    jsapiConfigured: !!(config.WXPAY.ENABLED && config.WXPAY.SUB_MCH_ID && config.WXPAY.ENV_ID)
  }
}

/** 顾客端首页：今日菜单（按分类分组）+ 取餐时段余量 + 支付配置 */
async function today(ctx) {
  const identity = ctx.identity || { merchantId: config.DEFAULT_MERCHANT_ID, merchantName: config.SHOP.name }
  const merchantId = identity.merchantId
  const dateKey = dates.shanghaiDateKey()
  const menuId = menuIdOf(dateKey, merchantId)
  const menu = await dbLib.getDocOrNull(ctx.db, COL.MENUS, menuId)
  const payment = await paymentInfo(ctx.db, merchantId)

  const base = {
    published: false,
    date: dateKey,
    dateLabel: dates.shanghaiDateLabel(dateKey),
    menuId,
    merchantId,
    merchantName: identity.merchantName || config.SHOP.name,
    title: identity.merchantName || config.SHOP.name,
    shop: Object.assign({}, config.SHOP, { name: identity.merchantName || config.SHOP.name }),
    payment,
    slots: [],
    categories: [],
    totalDishes: 0
  }

  if (!menu || menu.published === false) return base

  const dishIds = Array.isArray(menu.dishIds) ? menu.dishIds : []
  let dishes = []
  if (dishIds.length) {
    dishes = await dbLib.fetchAll(() =>
      ctx.db.collection(COL.DISHES).where({ merchantId, _id: ctx._.in(dishIds) })
    )
    dishes = dishes.filter((dish) => dish.onSale !== false)
  }

  // 分类配置：sort 升序，禁用分类不展示；没有分类文档时回落到菜品自带 category
  let categoryDocs = []
  try {
    categoryDocs = await dbLib.fetchAll(() =>
      ctx.db.collection(COL.CATEGORIES).where({ merchantId })
    )
  } catch (err) {
    categoryDocs = []
  }
  const grouped = categoriesCore.buildVisibleCategories(dishes, categoryDocs, dishView)
  const visibleCategories = grouped.categories

  // readSlots 兼容旧数据（字符串时段 / 缺 id / 缺 limit），避免前端出现「剩undefined」
  const readSlots = slotsCore.readSlots(menu.slots)
  const slotIds = readSlots.map((slot) => slot.id)
  const usage = await slotLib.getSlotUsage(ctx.db, ctx._, menuId, slotIds)
  const slots = readSlots.map((slot) => slotsCore.slotAvailability(slot, usage[slot.id] || 0))

  return Object.assign({}, base, {
    published: true,
    title: menu.title || identity.merchantName || config.SHOP.name,
    slots,
    categories: visibleCategories,
    totalDishes: grouped.dishCount,
    menuVersion: menu.menuVersion || null,
    updatedAt: menu.updatedAt || null
  })
}

/** 商家端/前端都可用的支付配置读取 */
async function payment(ctx) {
  const merchantId = (ctx.identity && ctx.identity.merchantId) || config.DEFAULT_MERCHANT_ID
  return paymentInfo(ctx.db, merchantId)
}

module.exports = { menuIdOf, dishView, paymentInfo, today, payment }
