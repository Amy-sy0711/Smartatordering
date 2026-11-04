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
const authLib = require('../lib/auth')
const slotLib = require('../lib/slots')
const settingsLib = require('../lib/settings')
const menuHandler = require('./menu')

function pad4(n) {
  const s = String(n)
  return s.length >= 4 ? s : ('0000' + s).slice(-4)
}

function isDuplicateErr(err) {
  const message = (err && (err.errMsg || err.message)) || ''
  return /duplicate|E11000|already exists/i.test(message) || (err && err.errCode === -502001)
}

/** 订单号：YYYYMMDD-0001（序号用 counters 集合按天自增，事务失败时退化为原子 inc） */
async function nextOrderNo(ctx, dateKey) {
  const compact = String(dateKey).replace(/-/g, '')
  const counterId = 'seq_' + compact
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
          data: { date: dateKey, seq: next, updatedAt: new Date() }
        })
        return next
      })
      return compact + '-' + pad4(seq)
    } catch (err) {
      if (attempt === 2) return nextOrderNoFallback(ctx, dateKey)
    }
  }
  return nextOrderNoFallback(ctx, dateKey)
}

async function nextOrderNoFallback(ctx, dateKey) {
  const compact = String(dateKey).replace(/-/g, '')
  const counterId = 'seq_' + compact
  const upd = await ctx.db
    .collection(COL.COUNTERS)
    .doc(counterId)
    .update({ data: { seq: ctx._.inc(1), updatedAt: new Date() } })
    .catch(() => null)
  if (!upd || !upd.stats || !upd.stats.updated) {
    await ctx.db
      .collection(COL.COUNTERS)
      .doc(counterId)
      .set({ data: { date: dateKey, seq: 1, updatedAt: new Date() } })
      .catch(() => {})
  }
  const doc = await dbLib.getDocOrNull(ctx.db, COL.COUNTERS, counterId)
  const seq = doc && Number.isInteger(doc.seq) ? doc.seq : 1
  return compact + '-' + pad4(seq)
}

async function createOrderDoc(ctx, params) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const orderNo = await nextOrderNo(ctx, params.dateKey)
    const now = new Date()
    const doc = {
      merchantId: config.MERCHANT_ID,
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

  const dateKey = dates.shanghaiDateKey()
  const menuId = menuHandler.menuIdOf(dateKey)
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
        ctx.db.collection(COL.DISHES).where({ merchantId: config.MERCHANT_ID, _id: ctx._.in(dishIds) })
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
  const settings = await settingsLib.getPaymentSettings(ctx.db)
  const payChannel = settings.payMode

  await slotLib.reserveSlot(ctx.db, ctx._, menuId, dateKey, slot)

  let created = null
  try {
    created = await createOrderDoc(ctx, { openid: ctx.openid, dateKey, menuId, slot, priced, remark, payChannel })
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

function orderView(order) {
  const totalCents = money.assertCents(order.totalCents || 0, '订单金额')
  return {
    orderId: order._id,
    orderNo: order.orderNo,
    status: order.status,
    statusText: state.STATUS_TEXT[order.status] || order.status,
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
    needConfirmReceipt: order.status === state.STATUS.PENDING_CONFIRM
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

  return steps.map((step) => ({
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
    if (status === state.STATUS.PENDING_CONFIRM) actions.push('confirm')
    if (status === state.STATUS.PAID) actions.push('accept')
    if (status === state.STATUS.ACCEPTED) actions.push('ready')
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
  const order = await dbLib.getDocOrNull(ctx.db, COL.ORDERS, id)
  if (!order) fail('ORDER_NOT_FOUND', '订单不存在')
  const isMerchant = await authLib.isMerchant(ctx.db, ctx.openid)
  if (order.buyerOpenid !== ctx.openid && !isMerchant) fail('FORBIDDEN', '无权查看该订单')
  return order
}

async function list(ctx) {
  const payload = ctx.payload || {}
  const page = Math.max(Number(payload.page) || 1, 1)
  const size = 20
  const res = await ctx.db
    .collection(COL.ORDERS)
    .where({ merchantId: config.MERCHANT_ID, buyerOpenid: ctx.openid })
    .orderBy('createdAt', 'desc')
    .skip((page - 1) * size)
    .limit(size)
    .get()
  const listData = (res.data || []).map(orderView)
  return { page, list: listData, hasMore: listData.length === size }
}

async function detail(ctx) {
  const order = await getOrderForUser(ctx, (ctx.payload || {}).orderId)
  const isMerchant = await authLib.isMerchant(ctx.db, ctx.openid)
  const payment = await menuHandler.paymentInfo(ctx.db)
  const totalCents = money.assertCents(order.totalCents || 0, '订单金额')

  return {
    orderId: order._id,
    orderNo: order.orderNo,
    date: order.date,
    status: order.status,
    statusText: state.STATUS_TEXT[order.status] || order.status,
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

  const settings = await settingsLib.getPaymentSettings(ctx.db)
  if (settings.payMode !== paymode.PAY_MODES.TRANSFER) {
    fail('PAY_MODE_MISMATCH', '当前收款方式已变更，请刷新后重试')
  }

  const target = state.assertAction(order.status, 'transfer')
  const note = String(payload.note || '').trim().slice(0, 40)
  const res = await ctx.db
    .collection(COL.ORDERS)
    .where({ _id: order._id, status: state.STATUS.PENDING_PAY })
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
  const isMerchant = await authLib.isMerchant(ctx.db, ctx.openid)
  const target = state.assertAction(order.status, 'cancel')
  const refunded = state.hasReceivedMoney(order)

  const res = await ctx.db
    .collection(COL.ORDERS)
    .where({ _id: order._id, status: order.status })
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
  const menu = await dbLib.getDocOrNull(ctx.db, COL.MENUS, menuHandler.menuIdOf(dateKey))
  const dishIds = (order.items || []).map((item) => item.dishId)
  const dishes = dishIds.length
    ? await dbLib.fetchAll(() =>
        ctx.db.collection(COL.DISHES).where({ merchantId: config.MERCHANT_ID, _id: ctx._.in(dishIds) })
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
