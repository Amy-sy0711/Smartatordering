'use strict'

const config = require('../config')
const { COLLECTIONS: COL } = require('../core/collections')
const dates = require('../core/dates')
const money = require('../core/money')
const pricing = require('../core/pricing')
const slotsCore = require('../core/slots')
const state = require('../core/state')
const paymode = require('../core/paymode')
const { fail } = require('../core/errors')
const dbLib = require('../lib/db')
const identityLib = require('../lib/identity')
const identityCore = require('../core/identity')
const slotLib = require('../lib/slots')
const settingsLib = require('../lib/settings')
const tenant = require('../core/tenant')
const menuHandler = require('./menu')

function pad4(n) {
  const s = String(n)
  return s.length >= 4 ? s : ('0000' + s).slice(-4)
}

function isDuplicateErr(err) {
  const message = (err && (err.errMsg || err.message)) || ''
  return /duplicate|E11000|already exists/i.test(message) || (err && err.errCode === -502001)
}

/**
 * 订单号：YYYYMMDD-0001。默认商家沿用旧计数器（seq_YYYYMMDD），
 * 其他商家使用 seq_<merchantId>_YYYYMMDD，保证租户间序号互不干扰。
 */
function counterIdOf(dateKey, merchantId) {
  return tenant.counterIdOf(dateKey, merchantId)
}

async function nextOrderNo(ctx, dateKey, merchantId) {
  const compact = String(dateKey).replace(/-/g, '')
  const counterId = counterIdOf(dateKey, merchantId)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const seq = await ctx.db.runTransaction(async (transaction) => {
        let doc = null
        try {
          const res = await transaction.collection(COL.COUNTERS).doc(counterId).get()
          doc = res && res.data
        } catch (err) {
          doc = null
        }
        const next = ((doc && doc.seq) || 0) + 1
        await transaction.collection(COL.COUNTERS).doc(counterId).set({
          data: { merchantId, date: dateKey, seq: next, updatedAt: new Date() }
        })
        return next
      })
      return compact + '-' + pad4(seq)
    } catch (err) {
      if (attempt === 2) return nextOrderNoFallback(ctx, dateKey, merchantId)
    }
  }
  return nextOrderNoFallback(ctx, dateKey, merchantId)
}

async function nextOrderNoFallback(ctx, dateKey, merchantId) {
  const compact = String(dateKey).replace(/-/g, '')
  const counterId = counterIdOf(dateKey, merchantId)
  const upd = await ctx.db
    .collection(COL.COUNTERS)
    .doc(counterId)
    .update({ data: { seq: ctx._.inc(1), updatedAt: new Date() } })
    .catch(() => null)
  if (!upd || !upd.stats || !upd.stats.updated) {
    await ctx.db
      .collection(COL.COUNTERS)
      .doc(counterId)
      .set({ data: { merchantId, date: dateKey, seq: 1, updatedAt: new Date() } })
      .catch(() => {})
  }
  const doc = await dbLib.getDocOrNull(ctx.db, COL.COUNTERS, counterId)
  const seq = doc && Number.isInteger(doc.seq) ? doc.seq : 1
  return compact + '-' + pad4(seq)
}

async function createOrderDoc(ctx, params) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const orderNo = await nextOrderNo(ctx, params.dateKey, params.merchantId)
    const now = new Date()
    const doc = {
      merchantId: params.merchantId,
      orderNo,
      date: params.dateKey,
      menuId: params.menuId,
      buyerOpenid: params.openid,
      items: params.priced.items,
      totalCents: params.priced.totalCents,
      totalQty: params.priced.totalQty,
      status: state.STATUS.PENDING_PAY,
      payChannel: params.payChannel,
      transactionId: '',
      paidAt: null,
      transferredAt: null,
      transferNote: '',
      confirmedAt: null,
      confirmedBy: '',
      pickupSlot: { id: params.slot.id, label: params.slot.label },
      remark: params.remark,
      packed: false,
      canceledAt: null,
      canceledBy: '',
      refunded: false,
      refundedCents: 0,
      statusHistory: [{ status: state.STATUS.PENDING_PAY, at: now, by: 'buyer' }],
      createdAt: now,
      updatedAt: now
    }
    try {
      await ctx.db.collection(COL.ORDERS).doc(orderNo).set({ data: doc })
      return { orderId: orderNo, orderNo, status: state.STATUS.PENDING_PAY }
    } catch (err) {
      // 订单号撞车（多实例并发）：换下一个序号重试
      if (isDuplicateErr(err) && attempt < 2) continue
      throw err
    }
  }
  fail('ORDER_NO_CONFLICT', '订单号生成冲突，请稍后重试')
}

/**
 * 下单：服务端重算价格 → 时段原子占位 → 生成订单号 → 落库
 * 前端传入的任何金额字段都不参与计算。
 */
async function create(ctx) {
  const payload = ctx.payload || {}
  if (!ctx.openid) fail('NO_OPENID', '未获取到用户身份，请在小程序内下单')

  const identity = ctx.identity || await identityLib.resolveIdentity(ctx)
  const gate = identityCore.canCreateOrder(identity)
  if (!gate.allowed) fail(gate.code, gate.message)
  const merchantId = identity.merchantId
  const flags = identity.merchantFlags || {}

  // 平台功能开关：停用下单 / 并发上限（管理台按租户配置）
  if (flags.disableOrdering === true) {
    fail('ORDERING_DISABLED', '该商家已暂停接单，请稍后再试')
  }
  const maxConcurrent = Number.isInteger(flags.maxConcurrentOrders) ? flags.maxConcurrentOrders : 0
  if (maxConcurrent > 0) {
    const activeRes = await ctx.db
      .collection(COL.ORDERS)
      .where({
        merchantId,
        date: dates.shanghaiDateKey(),
        status: ctx._.in([state.STATUS.PENDING_PAY, state.STATUS.PENDING_CONFIRM, state.STATUS.PAID, state.STATUS.ACCEPTED, state.STATUS.READY])
      })
      .count()
    if ((activeRes && activeRes.total) >= maxConcurrent) {
      fail('CONCURRENCY_LIMIT', '当前订单较多，请稍后再试')
    }
  }

  const dateKey = dates.shanghaiDateKey()
  const menuId = menuHandler.menuIdOf(dateKey, merchantId)
  const menu = await dbLib.getDocOrNull(ctx.db, COL.MENUS, menuId)
  if (!menu || menu.published === false) fail('MENU_NOT_PUBLISHED', '今日菜单尚未发布，暂时无法下单')

  const cartItems = Array.isArray(payload.cartItems) ? payload.cartItems : []
  const dishIds = []
  for (const item of cartItems) {
    const id = String((item && item.dishId) || '')
    if (id && dishIds.indexOf(id) < 0) dishIds.push(id)
  }
  const dishes = dishIds.length
    ? await dbLib.fetchAll(() =>
        ctx.db.collection(COL.DISHES).where({ merchantId, _id: ctx._.in(dishIds) })
      )
    : []

  const priced = pricing.recalculateOrder({
    dishes,
    cartItems,
    menuDishIds: menu.dishIds || [],
    maxQtyPerItem: config.MAX_QTY_PER_ITEM,
    maxLines: config.MAX_CART_LINES
  })

  const slot = slotsCore.findSlot(menu, payload.slotId)
  const remark = String(payload.remark || '').replace(/\s+/g, ' ').trim().slice(0, config.MAX_REMARK_LENGTH)
  const settings = await settingsLib.getPaymentSettings(ctx.db, merchantId)
  const payChannel = settings.payMode

  await slotLib.reserveSlot(ctx.db, ctx._, menuId, dateKey, slot)

  let created = null
  try {
    created = await createOrderDoc(ctx, {
      openid: ctx.openid,
      merchantId,
      dateKey,
      menuId,
      slot,
      priced,
      remark,
      payChannel
    })
  } catch (err) {
    await slotLib.releaseSlot(ctx.db, ctx._, menuId, slot.id).catch(() => {})
    throw err
  }

  return {
    orderId: created.orderId,
    orderNo: created.orderNo,
    status: created.status,
    statusText: state.STATUS_TEXT[created.status],
    totalCents: priced.totalCents,
    totalText: money.formatCents(priced.totalCents),
    totalQty: priced.totalQty,
    merchantId,
    merchantName: identity.merchantName,
    payChannel,
    payChannelLabel: paymode.PAY_MODE_LABELS[payChannel],
    transfer: settings.transfer,
    slot: { id: slot.id, label: slot.label }
  }
}

function itemViews(items) {
  return (items || []).map((item) => ({
    dishId: item.dishId,
    name: item.name,
    specText: item.specText || '',
    qty: item.qty,
    unitPriceCents: money.add(item.unitPriceCents, item.specDeltaCents || 0),
    unitPriceText: money.formatCents(money.add(item.unitPriceCents, item.specDeltaCents || 0)),
    priceDeltaText: item.specDeltaCents ? '+' + money.formatCents(item.specDeltaCents) : '',
    lineTotalCents: item.lineTotalCents,
    lineTotalText: money.formatCents(item.lineTotalCents)
  }))
}

function summaryText(order) {
  const parts = (order.items || []).map((item) => `${item.name}${item.specText ? '(' + item.specText + ')' : ''} x${item.qty}`)
  const text = parts.join('、')
  return text.length > 60 ? text.slice(0, 58) + '…' : text
}

/** 多租户改造前的旧订单没有 merchantId 字段，统一视作默认商家 */
function orderMerchantId(order) {
  return (order && order.merchantId) || config.DEFAULT_MERCHANT_ID
}

function isPickupStage(order) {
  return state.PICKUP_CODE_STATUSES.indexOf(order.status) >= 0
}

function pickupVisible(order) {
  return isPickupStage(order) && !!order.pickupCode
}

function pickupFields(order) {
  const show = pickupVisible(order)
  return {
    pickupCode: show ? order.pickupCode : '',
    pickupCodeText: show ? String(order.pickupCode) : '',
    pickupCodeWarning: show ? order.pickupCodeWarning || '' : '',
    // 历史 ready 订单可能早于取餐码功能，展示「请向商家询问取餐码」而不是空白
    pickupCodeMissing: isPickupStage(order) && !order.pickupCode
  }
}

function orderView(order) {
  const totalCents = money.assertCents(order.totalCents || 0, '订单金额')
  return {
    orderId: order._id,
    orderNo: order.orderNo,
    status: order.status,
    statusText: state.STATUS_TEXT[order.status] || order.status,
    customerStatusText: state.CUSTOMER_STATUS_TEXT[order.status] || state.STATUS_TEXT[order.status] || order.status,
    totalCents,
    totalText: money.formatCents(totalCents),
    totalQty: order.totalQty || 0,
    itemSummary: summaryText(order),
    slotLabel: (order.pickupSlot && order.pickupSlot.label) || '',
    remark: order.remark || '',
    packed: order.packed === true,
    payChannel: order.payChannel || '',
    payChannelLabel: paymode.PAY_MODE_LABELS[order.payChannel] || '',
    createdAtText: dates.shanghaiShortTime(order.createdAt),
    canPay: order.status === state.STATUS.PENDING_PAY,
    canCancel: state.ACTION_RULES.cancel.from.indexOf(order.status) >= 0,
    // 转账订单：顾客点了「我已转账」或还没点，商家都能确认收款
    needConfirmReceipt:
      (order.payChannel ? order.payChannel === paymode.PAY_MODES.TRANSFER : true) &&
      state.ACTION_RULES.confirm.from.indexOf(order.status) >= 0,
    ...pickupFields(order)
  }
}

function timeline(order) {
  const steps = [
    { key: 'pending_pay', label: '待付款' },
    { key: 'pending_confirm', label: '待确认收款' },
    { key: 'paid', label: '已收款' },
    { key: 'accepted', label: '制作中' },
    { key: 'ready', label: '可取餐' },
    { key: 'completed', label: '已完成' }
  ].filter((step) => step.key !== 'pending_confirm' || order.payChannel === paymode.PAY_MODES.TRANSFER)

  const reached = {}
  for (const item of order.statusHistory || []) reached[item.status] = true

  // 新流程不再经过 accepted（接单）；只有历史订单走过才展示这一步
  const visible = steps.filter((step) => step.key !== 'accepted' || !!reached.accepted)

  return visible.map((step) => ({
    key: step.key,
    label: step.label,
    done: !!reached[step.key],
    current: step.key === order.status
  }))
}

function availableActions(order, isMerchant) {
  const status = order.status
  const actions = []
  if (isMerchant) {
    const isTransfer = order.payChannel ? order.payChannel === paymode.PAY_MODES.TRANSFER : true
    if (isTransfer && state.ACTION_RULES.confirm.from.indexOf(status) >= 0) actions.push('confirm')
    // 已收款即可出餐（不再需要「接单」）；accepted 仅用于兼容历史订单
    if (status === state.STATUS.PAID || status === state.STATUS.ACCEPTED) actions.push('ready')
    if (status === state.STATUS.READY) actions.push('complete')
  } else if (status === state.STATUS.PENDING_PAY) {
    actions.push('pay')
  }
  if (status !== state.STATUS.COMPLETED && state.ACTION_RULES.cancel.from.indexOf(status) >= 0) {
    actions.push('cancel')
  }
  return actions
}

async function getOrderForUser(ctx, orderId) {
  const id = String(orderId || '')
  if (!id) fail('ORDER_ID_REQUIRED', '缺少订单号')
  const identity = ctx.identity || await identityLib.resolveIdentity(ctx)
  // 先按 _id 取，再在内存里校验租户：旧订单没有 merchantId 字段，硬编码 where 会查不到
  const order = await dbLib.getDocOrNull(ctx.db, COL.ORDERS, id)
  if (!order) fail('ORDER_NOT_FOUND', '订单不存在')
  order.merchantId = orderMerchantId(order)
  if (order.merchantId !== identity.merchantId) fail('ORDER_NOT_FOUND', '订单不存在')
  if (!identityCore.canAccessOrder(identity, order)) fail('FORBIDDEN', '无权查看该订单')
  ctx.identity = identity
  return order
}

async function list(ctx) {
  const payload = ctx.payload || {}
  const page = Math.max(Number(payload.page) || 1, 1)
  const size = 20
  const identity = ctx.identity || await identityLib.resolveIdentity(ctx)
  // 只按买家 openid 取本人「全部」订单，再在内存里按商家过滤：
  //  1) 不附加任何日期条件，跨天历史订单不会消失；
  //  2) 兼容多租户改造前的旧订单（没有 merchantId 字段，视为默认商家）；
  //  3) 内存排序 + 分页，避免老订单因排序字段缺失被截断。
  const all = await dbLib.fetchAll(() =>
    ctx.db.collection(COL.ORDERS).where({ buyerOpenid: ctx.openid })
  )
  const mine = all
    .filter((order) => orderMerchantId(order) === identity.merchantId)
    .sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return (tb - ta) || String(b.orderNo || b._id).localeCompare(String(a.orderNo || a._id))
    })
  const start = (page - 1) * size
  const listData = mine.slice(start, start + size).map((order) => {
    const view = orderView(order)
    view.merchantId = orderMerchantId(order)
    return view
  })
  return { page, list: listData, hasMore: start + size < mine.length, total: mine.length }
}

async function detail(ctx) {
  const order = await getOrderForUser(ctx, (ctx.payload || {}).orderId)
  const identity = ctx.identity || {}
  const isMerchant = identityCore.canAccessOrder(identity, order) && identity.role !== 'customer'
  const payment = await menuHandler.paymentInfo(ctx.db, order.merchantId)
  const totalCents = money.assertCents(order.totalCents || 0, '订单金额')

  return {
    orderId: order._id,
    orderNo: order.orderNo,
    merchantId: order.merchantId || '',
    merchantName: identity.merchantId === order.merchantId ? identity.merchantName : '',
    date: order.date,
    status: order.status,
    statusText: state.STATUS_TEXT[order.status] || order.status,
    customerStatusText: state.CUSTOMER_STATUS_TEXT[order.status] || state.STATUS_TEXT[order.status] || order.status,
    pickupCode: pickupFields(order).pickupCode,
    pickupCodeText: pickupFields(order).pickupCodeText,
    pickupCodeWarning: pickupFields(order).pickupCodeWarning,
    pickupCodeMissing: pickupFields(order).pickupCodeMissing,
    payChannel: order.payChannel || '',
    payChannelLabel: paymode.PAY_MODE_LABELS[order.payChannel] || '',
    totalCents,
    totalText: money.formatCents(totalCents),
    totalQty: order.totalQty || 0,
    items: itemViews(order.items),
    remark: order.remark || '',
    packed: order.packed === true,
    slot: { id: (order.pickupSlot && order.pickupSlot.id) || '', label: (order.pickupSlot && order.pickupSlot.label) || '' },
    refunded: order.refunded === true,
    refundedText: money.formatCents(order.refundedCents || 0),
    transactionId: order.transactionId || '',
    transferNote: order.transferNote || '',
    timeline: timeline(order),
    statusHistory: (order.statusHistory || []).map((item) => ({
      status: item.status,
      label: state.STATUS_TEXT[item.status] || item.status,
      atText: dates.shanghaiDateTime(item.at),
      by: item.by || ''
    })),
    createdAtText: dates.shanghaiDateTime(order.createdAt),
    paidAtText: order.paidAt ? dates.shanghaiDateTime(order.paidAt) : '',
    transferredAtText: order.transferredAt ? dates.shanghaiDateTime(order.transferredAt) : '',
    confirmedAtText: order.confirmedAt ? dates.shanghaiDateTime(order.confirmedAt) : '',
    completedAtText: order.completedAt ? dates.shanghaiDateTime(order.completedAt) : '',
    canceledAtText: order.canceledAt ? dates.shanghaiDateTime(order.canceledAt) : '',
    payment,
    isMerchant,
    actions: availableActions(order, isMerchant),
    confirmInfo: { operator: order.confirmedBy || '', at: order.confirmedAt ? dates.shanghaiDateTime(order.confirmedAt) : '' }
  }
}

/** 顾客：我已转账（pending_pay → pending_confirm） */
async function markTransferred(ctx) {
  const payload = ctx.payload || {}
  const order = await getOrderForUser(ctx, payload.orderId)
  if (order.buyerOpenid !== ctx.openid) fail('FORBIDDEN', '只有下单本人可以标记转账')

  const settings = await settingsLib.getPaymentSettings(ctx.db, order.merchantId)
  if (settings.payMode !== paymode.PAY_MODES.TRANSFER) {
    fail('PAY_MODE_MISMATCH', '当前收款方式已变更，请刷新后重试')
  }

  const target = state.assertAction(order.status, 'transfer')
  const note = String(payload.note || '').trim().slice(0, 40)
  const res = await ctx.db
    .collection(COL.ORDERS)
    .where({ _id: order._id, status: state.STATUS.PENDING_PAY, merchantId: order.merchantId })
    .update({
      data: {
        status: target,
        payChannel: paymode.PAY_MODES.TRANSFER,
        transferredAt: new Date(),
        transferNote: note,
        updatedAt: new Date(),
        statusHistory: ctx._.push({ status: target, at: new Date(), by: 'buyer' })
      }
    })
  if (!res.stats || !res.stats.updated) fail('CONCURRENT_MODIFIED', '订单状态已变化，请刷新后重试')

  return { orderId: order._id, status: target, statusText: state.STATUS_TEXT[target] }
}

/** 顾客/商家取消订单（已收款订单会标记为退款口径） */
async function cancel(ctx) {
  const order = await getOrderForUser(ctx, (ctx.payload || {}).orderId)
  const identity = ctx.identity || {}
  const isBuyer = order.buyerOpenid === ctx.openid
  const isMerchant = !isBuyer && identityCore.canAccessOrder(identity, order)
  if (isMerchant) {
    const decision = identityCore.decideMerchantAccess(identity, { write: true })
    if (!decision.allowed) fail(decision.code, decision.message)
  }
  const target = state.assertAction(order.status, 'cancel')
  const refunded = state.hasReceivedMoney(order)

  const res = await ctx.db
    .collection(COL.ORDERS)
    .where({ _id: order._id, status: order.status, merchantId: order.merchantId })
    .update({
      data: {
        status: target,
        canceledAt: new Date(),
        canceledBy: isMerchant ? 'merchant' : 'buyer',
        refunded,
        refundedCents: refunded ? money.assertCents(order.totalCents, '订单金额') : 0,
        updatedAt: new Date(),
        statusHistory: ctx._.push({ status: target, at: new Date(), by: isMerchant ? 'merchant' : 'buyer' })
      }
    })
  if (!res.stats || !res.stats.updated) fail('CONCURRENT_MODIFIED', '订单状态已变化，请刷新后重试')

  await slotLib.releaseSlot(ctx.db, ctx._, order.menuId, order.pickupSlot && order.pickupSlot.id).catch(() => {})

  return { orderId: order._id, status: target, statusText: state.STATUS_TEXT[target], refunded }
}

/** 再来一单：把历史订单映射为购物车行，并标注今日是否可点 */
async function reorder(ctx) {
  const order = await getOrderForUser(ctx, (ctx.payload || {}).orderId)
  if (order.buyerOpenid !== ctx.openid) fail('FORBIDDEN', '只有下单本人可以使用再来一单')

  const dateKey = dates.shanghaiDateKey()
  const menu = await dbLib.getDocOrNull(ctx.db, COL.MENUS, menuHandler.menuIdOf(dateKey, order.merchantId))
  const dishIds = (order.items || []).map((item) => item.dishId)
  const dishes = dishIds.length
    ? await dbLib.fetchAll(() =>
        ctx.db.collection(COL.DISHES).where({ merchantId: order.merchantId, _id: ctx._.in(dishIds) })
      )
    : []
  const dishMap = {}
  for (const dish of dishes) dishMap[dish._id] = dish
  const menuDishIds = (menu && menu.dishIds) || []

  const items = (order.items || []).map((item) => {
    const dish = dishMap[item.dishId]
    let available = false
    let reason = ''
    if (!menu || menu.published === false) reason = '今日菜单未发布'
    else if (!dish || dish.onSale === false) reason = '已下架'
    else if (menuDishIds.indexOf(item.dishId) < 0) reason = '不在今日菜单'
    else if (dish.soldOut === true) reason = '已售罄'
    else available = true

    let specDeltaCents = 0
    if (dish && available) {
      try {
        specDeltaCents = pricing.resolveSpecs(dish, item.specOptionIds || []).specDeltaCents
      } catch (err) {
        // 规格已被商家修改，旧规格无法复用，需顾客重新选择
        specDeltaCents = 0
        available = false
        reason = '规格已变更，请重新选择'
      }
    }

    return {
      dishId: item.dishId,
      name: dish ? dish.name : item.name,
      specOptionIds: item.specOptionIds || [],
      specText: item.specText || '',
      qty: item.qty,
      priceCents: dish ? dish.priceCents : item.unitPriceCents || 0,
      specDeltaCents,
      priceText: dish ? money.formatCents(dish.priceCents) : money.formatCents(item.unitPriceCents || 0),
      available,
      reason
    }
  })

  return { items, availableCount: items.filter((item) => item.available).length }
}

module.exports = { create, list, detail, markTransferred, cancel, reorder, nextOrderNo, orderView, itemViews, availableActions }
