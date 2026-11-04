'use strict'

const config = require('../config')
const { COLLECTIONS: COL } = require('../core/collections')
const { fail } = require('../core/errors')
const dates = require('../core/dates')
const money = require('../core/money')
const packingCore = require('../core/packing')
const slotsCore = require('../core/slots')
const state = require('../core/state')
const statsCore = require('../core/stats')
const paymode = require('../core/paymode')
const dbLib = require('../lib/db')
const authLib = require('../lib/auth')
const slotLib = require('../lib/slots')
const settingsLib = require('../lib/settings')
const menuHandler = require('./menu')
const orderHandler = require('./order')

async function requireMerchant(ctx) {
  return authLib.ensureMerchant(ctx.db, ctx._, ctx.openid)
}

/** 商家入口准入检查；claim=true 时尝试自助成为商家（仅演示模式） */
async function checkAccess(ctx) {
  const payload = ctx.payload || {}
  let bootstrapped = false
  if (payload.claim) {
    const result = await authLib.ensureMerchant(ctx.db, ctx._, ctx.openid)
    bootstrapped = result.bootstrapped
  }
  const isMerchant = await authLib.isMerchant(ctx.db, ctx.openid)
  return {
    isMerchant,
    bootstrapped,
    openid: ctx.openid,
    merchantId: config.MERCHANT_ID,
    canBootstrap: authLib.bootstrapAllowed()
  }
}

/* ------------------------------ 菜品管理 ------------------------------ */

async function listDishes(ctx) {
  await requireMerchant(ctx)
  const dishes = await dbLib.fetchAll(() =>
    ctx.db.collection(COL.DISHES).where({ merchantId: config.MERCHANT_ID }).orderBy('sortOrder', 'asc')
  )
  dishes.sort((a, b) => {
    const ao = Number.isInteger(a.sortOrder) ? a.sortOrder : 0
    const bo = Number.isInteger(b.sortOrder) ? b.sortOrder : 0
    const catA = String(a.category || '')
    const catB = String(b.category || '')
    return (ao - bo) || catA.localeCompare(catB) || String(a.name).localeCompare(String(b.name))
  })
  return { list: dishes.map(menuHandler.dishView), total: dishes.length }
}

function sanitizeDish(input) {
  const src = input || {}
  const name = String(src.name || '').trim()
  if (!name) fail('DISH_NAME_REQUIRED', '菜品名称不能为空')
  if (name.length > 20) fail('DISH_NAME_INVALID', '菜品名称最长 20 个字符')

  const category = (String(src.category || '其他').trim() || '其他').slice(0, 10)
  const priceCents = money.assertCents(src.priceCents, '菜品价格')
  if (priceCents < 0 || priceCents > 1000000) fail('DISH_PRICE_INVALID', '菜品价格不合法（0 - 10000 元）')
  const imageUrl = String(src.imageUrl || '').trim().slice(0, 400)

  let specs = []
  if (Array.isArray(src.specs)) {
    if (src.specs.length > 5) fail('SPEC_INVALID', '最多 5 组规格')
    specs = src.specs.map((group, gi) => {
      const groupName = String((group && group.name) || '').trim()
      if (!groupName) fail('SPEC_INVALID', '规格组名称不能为空')
      const rawOptions = Array.isArray(group.options) ? group.options.slice(0, 10) : []
      if (!rawOptions.length) fail('SPEC_INVALID', `规格组「${groupName}」至少需要一个选项`)
      const groupId = 'g' + (gi + 1)
      const options = rawOptions.map((option, oi) => {
        const label = String((option && option.label) || '').trim()
        if (!label) fail('SPEC_INVALID', '规格选项名称不能为空')
        const delta = option.priceDeltaCents === undefined ? 0 : option.priceDeltaCents
        money.assertCents(delta, `规格「${label}」加价`)
        if (priceCents + delta < 0) fail('SPEC_INVALID', '规格加价不能导致菜品价格为负')
        return {
          // 选项 ID 全局唯一（组前缀 + 组内序号），避免多组同名 ID 导致选规格歧义
          id: groupId + 'o' + (oi + 1),
          label: label.slice(0, 12),
          priceDeltaCents: delta
        }
      })
      return {
        id: groupId,
        name: groupName.slice(0, 12),
        required: group.required !== false,
        options
      }
    })
  }

  return {
    name,
    category,
    priceCents,
    imageUrl,
    specs,
    sortOrder: Number.isInteger(src.sortOrder) ? src.sortOrder : 0,
    onSale: src.onSale !== false,
    soldOut: src.soldOut === true
  }
}

async function saveDish(ctx) {
  await requireMerchant(ctx)
  const payload = ctx.payload || {}
  const data = sanitizeDish(payload.dish)
  const dishId = String(payload.dishId || '')

  if (dishId) {
    const existing = await dbLib.getDocOrNull(ctx.db, COL.DISHES, dishId)
    if (!existing) fail('DISH_NOT_FOUND', '菜品不存在')
    await ctx.db.collection(COL.DISHES).doc(dishId).update({ data: Object.assign({}, data, { updatedAt: new Date() }) })
    return { dishId, created: false }
  }

  const res = await ctx.db.collection(COL.DISHES).add({
    data: Object.assign({}, data, {
      merchantId: config.MERCHANT_ID,
      createdAt: new Date(),
      updatedAt: new Date()
    })
  })
  return { dishId: res._id, created: true }
}

async function toggleDish(ctx) {
  await requireMerchant(ctx)
  const payload = ctx.payload || {}
  const field = String(payload.field || '')
  if (field !== 'onSale' && field !== 'soldOut') fail('FIELD_INVALID', '只支持切换 onSale / soldOut')
  const dishId = String(payload.dishId || '')
  const existing = await dbLib.getDocOrNull(ctx.db, COL.DISHES, dishId)
  if (!existing) fail('DISH_NOT_FOUND', '菜品不存在')
  const value = payload.value === true
  await ctx.db.collection(COL.DISHES).doc(dishId).update({ data: { [field]: value, updatedAt: new Date() } })
  return { dishId, field, value }
}

async function deleteDish(ctx) {
  await requireMerchant(ctx)
  const dishId = String((ctx.payload || {}).dishId || '')
  const existing = await dbLib.getDocOrNull(ctx.db, COL.DISHES, dishId)
  if (!existing) fail('DISH_NOT_FOUND', '菜品不存在')
  await ctx.db.collection(COL.DISHES).doc(dishId).remove()
  // 同步从今日菜单移除，避免菜单里出现幽灵菜品
  const dateKey = dates.shanghaiDateKey()
  await ctx.db
    .collection(COL.MENUS)
    .doc(menuHandler.menuIdOf(dateKey))
    .update({ data: { dishIds: ctx._.pull(dishId), updatedAt: new Date() } })
    .catch(() => {})
  return { dishId, removed: true }
}

/* ------------------------------ 菜单发布 ------------------------------ */

async function allOnSaleDishIds(ctx) {
  const dishes = await dbLib.fetchAll(() => ctx.db.collection(COL.DISHES).where({ merchantId: config.MERCHANT_ID }))
  return dishes.filter((dish) => dish.onSale !== false).map((dish) => dish._id)
}

async function publishMenuInternal(ctx, options) {
  const opts = options || {}
  const dateKey = opts.date || dates.shanghaiDateKey()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) fail('DATE_INVALID', '日期格式必须为 YYYY-MM-DD')

  const menuId = menuHandler.menuIdOf(dateKey)
  const existing = await dbLib.getDocOrNull(ctx.db, COL.MENUS, menuId)
  const slots = slotsCore.normalizeSlots(
    opts.slots || (existing && existing.slots) || config.DEFAULT_SLOTS,
    config.DEFAULT_SLOT_LIMIT
  )

  let dishIds = null
  if (Array.isArray(opts.dishIds) && opts.dishIds.length) {
    const raw = []
    for (const id of opts.dishIds) {
      const value = String(id)
      if (value && raw.indexOf(value) < 0) raw.push(value)
    }
    const found = await dbLib.fetchAll(() =>
      ctx.db.collection(COL.DISHES).where({ merchantId: config.MERCHANT_ID, _id: ctx._.in(raw) })
    )
    if (found.length !== raw.length) fail('DISH_NOT_FOUND', '部分菜品已不存在，请刷新后重新选择')
    dishIds = raw
  } else if (existing && Array.isArray(existing.dishIds) && existing.dishIds.length) {
    dishIds = existing.dishIds
  } else {
    dishIds = await allOnSaleDishIds(ctx)
  }
  if (!dishIds.length) fail('DISH_EMPTY', '没有可发布的菜品，请先新增菜品')

  const title = (String(opts.title || (existing && existing.title) || '今日菜单').trim() || '今日菜单').slice(0, 20)

  await ctx.db.collection(COL.MENUS).doc(menuId).set({
    data: {
      merchantId: config.MERCHANT_ID,
      date: dateKey,
      menuId,
      title,
      dishIds,
      slots,
      published: true,
      createdAt: (existing && existing.createdAt) || new Date(),
      updatedAt: new Date(),
      publishedBy: ctx.openid
    }
  })

  for (const slot of slots) {
    await slotLib.ensureSlotCounter(ctx.db, menuId, dateKey, slot)
  }

  return { menuId, date: dateKey, dateLabel: dates.shanghaiDateLabel(dateKey), title, dishCount: dishIds.length, slots }
}

async function publishMenu(ctx) {
  await requireMerchant(ctx)
  const payload = ctx.payload || {}
  return publishMenuInternal(ctx, {
    date: payload.date,
    title: payload.title,
    slots: payload.slots,
    dishIds: payload.dishIds
  })
}

/** 从历史菜单一键复制（复制菜品集合 + 取餐时段） */
async function copyMenu(ctx) {
  await requireMerchant(ctx)
  const payload = ctx.payload || {}
  const fromDate = String(payload.fromDate || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) fail('DATE_INVALID', '请选择要复制的历史菜单日期')
  const source = await dbLib.getDocOrNull(ctx.db, COL.MENUS, menuHandler.menuIdOf(fromDate))
  if (!source) fail('MENU_NOT_FOUND', '历史菜单不存在')

  return publishMenuInternal(ctx, {
    date: payload.date || dates.shanghaiDateKey(),
    title: payload.title || source.title,
    slots: source.slots,
    dishIds: source.dishIds
  })
}

async function menuHistory(ctx) {
  await requireMerchant(ctx)
  const res = await ctx.db
    .collection(COL.MENUS)
    .where({ merchantId: config.MERCHANT_ID })
    .orderBy('date', 'desc')
    .limit(30)
    .get()
  const today = dates.shanghaiDateKey()
  return {
    list: (res.data || []).map((menu) => ({
      date: menu.date,
      dateLabel: dates.shanghaiDateLabel(menu.date),
      title: menu.title,
      dishCount: (menu.dishIds || []).length,
      slotCount: (menu.slots || []).length,
      isToday: menu.date === today
    }))
  }
}

async function menuDetail(ctx) {
  await requireMerchant(ctx)
  const dateKey = String((ctx.payload || {}).date || dates.shanghaiDateKey())
  const menu = await dbLib.getDocOrNull(ctx.db, COL.MENUS, menuHandler.menuIdOf(dateKey))
  if (!menu) return { published: false, date: dateKey, dateLabel: dates.shanghaiDateLabel(dateKey) }
  return {
    published: menu.published !== false,
    date: menu.date,
    dateLabel: dates.shanghaiDateLabel(menu.date),
    title: menu.title,
    dishIds: menu.dishIds || [],
    slots: menu.slots || []
  }
}

/* ------------------------------ 订单看板 ------------------------------ */

function merchantOrderView(order) {
  const totalCents = money.assertCents(order.totalCents || 0, '订单金额')
  return Object.assign({}, orderHandler.orderView(order), {
    items: orderHandler.itemViews(order.items),
    buyerOpenid: order.buyerOpenid || '',
    date: order.date,
    payChannelLabel: paymode.PAY_MODE_LABELS[order.payChannel] || '',
    transferredAtText: order.transferredAt ? dates.shanghaiDateTime(order.transferredAt) : '',
    confirmedAtText: order.confirmedAt ? dates.shanghaiDateTime(order.confirmedAt) : '',
    transferNote: order.transferNote || '',
    totalText: money.formatCents(totalCents)
  })
}

async function orders(ctx) {
  await requireMerchant(ctx)
  const payload = ctx.payload || {}
  const dateKey = String(payload.date || dates.shanghaiDateKey())
  const where = { merchantId: config.MERCHANT_ID, date: dateKey }
  if (Array.isArray(payload.statuses) && payload.statuses.length) {
    const valid = payload.statuses.filter((s) => state.STATUS_TEXT[s])
    if (valid.length) where.status = ctx._.in(valid)
  }
  const listData = await dbLib.fetchAll(() =>
    ctx.db.collection(COL.ORDERS).where(where).orderBy('createdAt', 'desc')
  )
  return {
    date: dateKey,
    dateLabel: dates.shanghaiDateLabel(dateKey),
    list: listData.map(merchantOrderView),
    total: listData.length
  }
}

async function getOrderOrThrow(ctx, orderId) {
  const id = String(orderId || '')
  if (!id) fail('ORDER_ID_REQUIRED', '缺少订单号')
  const order = await dbLib.getDocOrNull(ctx.db, COL.ORDERS, id)
  if (!order) fail('ORDER_NOT_FOUND', '订单不存在')
  return order
}

/** 商家推进状态：接单 / 出餐 / 完成 / 取消（非法流转直接拒绝） */
async function transition(ctx) {
  await requireMerchant(ctx)
  const payload = ctx.payload || {}
  const action = String(payload.action || '')
  const allowed = ['accept', 'ready', 'complete', 'cancel']
  if (allowed.indexOf(action) < 0) fail('ACTION_NOT_ALLOWED', '商家端只支持 accept / ready / complete / cancel')

  const order = await getOrderOrThrow(ctx, payload.orderId)
  const target = state.assertAction(order.status, action)
  const now = new Date()
  const patch = {
    status: target,
    updatedAt: now,
    statusHistory: ctx._.push({ status: target, at: now, by: 'merchant' })
  }
  if (target === state.STATUS.ACCEPTED) patch.acceptedAt = now
  if (target === state.STATUS.READY) patch.readyAt = now
  if (target === state.STATUS.COMPLETED) patch.completedAt = now
  if (target === state.STATUS.CANCELED) {
    patch.canceledAt = now
    patch.canceledBy = 'merchant'
    patch.refunded = state.hasReceivedMoney(order)
    patch.refundedCents = patch.refunded ? money.assertCents(order.totalCents, '订单金额') : 0
  }

  const res = await ctx.db
    .collection(COL.ORDERS)
    .where({ _id: order._id, status: order.status })
    .update({ data: patch })
  if (!res.stats || !res.stats.updated) fail('CONCURRENT_MODIFIED', '订单状态已被更新，请刷新后重试')

  if (target === state.STATUS.CANCELED) {
    await slotLib.releaseSlot(ctx.db, ctx._, order.menuId, order.pickupSlot && order.pickupSlot.id).catch(() => {})
  }

  const fresh = await getOrderOrThrow(ctx, order._id)
  return merchantOrderView(fresh)
}

/**
 * 商家确认已收款（pending_confirm → paid），并落一条收款记录用于对账。
 * 收款记录 _id 固定为 pr_<orderId>，天然防止重复确认。
 */
async function confirmReceipt(ctx) {
  await requireMerchant(ctx)
  const payload = ctx.payload || {}
  const order = await getOrderOrThrow(ctx, payload.orderId)

  if (order.payChannel && order.payChannel !== paymode.PAY_MODES.TRANSFER) {
    fail('PAY_CHANNEL_MISMATCH', '该订单不是转账收款订单，无需人工确认')
  }
  const target = state.assertAction(order.status, 'confirm')
  const recordId = 'pr_' + order._id

  const existingRecord = await dbLib.getDocOrNull(ctx.db, COL.PAYMENT_RECORDS, recordId)
  if (existingRecord) fail('ALREADY_CONFIRMED', '该订单已确认收款，请勿重复操作')

  const amountCents = money.assertCents(order.totalCents, '订单金额')
  const now = new Date()
  try {
    await ctx.db.collection(COL.PAYMENT_RECORDS).add({
      data: {
        _id: recordId,
        orderId: order._id,
        orderNo: order.orderNo,
        merchantId: config.MERCHANT_ID,
        date: order.date,
        amountCents,
        channel: paymode.PAY_MODES.TRANSFER,
        operatorOpenid: ctx.openid,
        at: now,
        note: String(payload.note || '').trim().slice(0, 100),
        createdAt: now
      }
    })
  } catch (err) {
    fail('ALREADY_CONFIRMED', '该订单已确认收款，请勿重复操作')
  }

  const res = await ctx.db
    .collection(COL.ORDERS)
    .where({ _id: order._id, status: state.STATUS.PENDING_CONFIRM })
    .update({
      data: {
        status: target,
        paidAt: now,
        confirmedAt: now,
        confirmedBy: ctx.openid,
        transactionId: 'TRANSFER-' + order.orderNo,
        updatedAt: now,
        statusHistory: ctx._.push({ status: target, at: now, by: 'merchant' })
      }
    })
  if (!res.stats || !res.stats.updated) {
    await ctx.db.collection(COL.PAYMENT_RECORDS).doc(recordId).remove().catch(() => {})
    fail('CONCURRENT_MODIFIED', '订单状态已变化，请刷新后重试')
  }

  const fresh = await getOrderOrThrow(ctx, order._id)
  return {
    order: merchantOrderView(fresh),
    record: {
      recordId,
      amountCents,
      amountText: money.formatCents(amountCents),
      operatorOpenid: ctx.openid,
      atText: dates.shanghaiDateTime(now)
    }
  }
}

/* ------------------------------ 打包 / 收益 ------------------------------ */

async function packing(ctx) {
  await requireMerchant(ctx)
  const dateKey = String((ctx.payload || {}).date || dates.shanghaiDateKey())
  const listData = await dbLib.fetchAll(() =>
    ctx.db
      .collection(COL.ORDERS)
      .where({
        merchantId: config.MERCHANT_ID,
        date: dateKey,
        status: ctx._.in(state.UNFINISHED_PAID_STATUSES)
      })
      .orderBy('createdAt', 'asc')
  )
  return packingCore.buildPackingList(listData, {
    date: dateKey,
    dateLabel: dates.shanghaiDateLabel(dateKey)
  })
}

async function setPacked(ctx) {
  await requireMerchant(ctx)
  const payload = ctx.payload || {}
  const order = await getOrderOrThrow(ctx, payload.orderId)
  if (state.UNFINISHED_PAID_STATUSES.indexOf(order.status) < 0) {
    fail('ORDER_NOT_PACKABLE', '只有已收款且未完成的订单可以标记打包')
  }
  const packed = payload.packed === true
  await ctx.db.collection(COL.ORDERS).doc(order._id).update({ data: { packed, packedAt: packed ? new Date() : null, updatedAt: new Date() } })
  return { orderId: order._id, packed }
}

async function stats(ctx) {
  await requireMerchant(ctx)
  const dateKey = String((ctx.payload || {}).date || dates.shanghaiDateKey())
  const listData = await dbLib.fetchAll(() =>
    ctx.db.collection(COL.ORDERS).where({ merchantId: config.MERCHANT_ID, date: dateKey })
  )
  const result = statsCore.buildDailyStats(listData, { date: dateKey })
  result.dateLabel = dates.shanghaiDateLabel(dateKey)

  const recordRes = await ctx.db
    .collection(COL.PAYMENT_RECORDS)
    .where({ merchantId: config.MERCHANT_ID, date: dateKey })
    .orderBy('at', 'desc')
    .limit(50)
    .get()
  result.paymentRecords = (recordRes.data || []).map((record) => ({
    orderNo: record.orderNo,
    amountCents: record.amountCents,
    amountText: money.formatCents(record.amountCents),
    channelLabel: paymode.PAY_MODE_LABELS[record.channel] || record.channel,
    atText: dates.shanghaiShortTime(record.at),
    operatorOpenid: record.operatorOpenid
  }))
  return result
}

/* ------------------------------ 支付配置 ------------------------------ */

async function savePaymentSettings(ctx) {
  await requireMerchant(ctx)
  const saved = await settingsLib.savePaymentSettings(ctx.db, ctx.payload || {}, ctx.openid)
  const branch = paymode.resolvePayBranch({
    payMode: saved.payMode,
    wxpayEnabled: config.WXPAY.ENABLED,
    subMchId: config.WXPAY.SUB_MCH_ID,
    envId: config.WXPAY.ENV_ID
  })
  return {
    settings: saved,
    payModeLabel: paymode.PAY_MODE_LABELS[saved.payMode],
    usable: branch.usable,
    warning: branch.usable ? '' : branch.message || ''
  }
}

async function getPaymentSettings(ctx) {
  await requireMerchant(ctx)
  const settings = await settingsLib.getPaymentSettings(ctx.db)
  const branch = paymode.resolvePayBranch({
    payMode: settings.payMode,
    wxpayEnabled: config.WXPAY.ENABLED,
    subMchId: config.WXPAY.SUB_MCH_ID,
    envId: config.WXPAY.ENV_ID
  })
  return {
    settings,
    payModeLabel: paymode.PAY_MODE_LABELS[settings.payMode],
    usable: branch.usable,
    warning: branch.usable ? '' : branch.message || '',
    modes: [
      { value: paymode.PAY_MODES.TRANSFER, label: paymode.PAY_MODE_LABELS.transfer },
      { value: paymode.PAY_MODES.JSAPI, label: paymode.PAY_MODE_LABELS.jsapi },
      { value: paymode.PAY_MODES.MOCK, label: paymode.PAY_MODE_LABELS.mock }
    ],
    jsapiConfigured: !!(config.WXPAY.ENABLED && config.WXPAY.SUB_MCH_ID && config.WXPAY.ENV_ID)
  }
}

module.exports = {
  checkAccess,
  listDishes,
  saveDish,
  toggleDish,
  deleteDish,
  publishMenu,
  copyMenu,
  menuHistory,
  menuDetail,
  orders,
  transition,
  confirmReceipt,
  packing,
  setPacked,
  stats,
  savePaymentSettings,
  getPaymentSettings,
  publishMenuInternal,
  sanitizeDish
}
