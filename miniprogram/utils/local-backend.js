'use strict'

/**
 * 本地演示模式（local）数据后端：
 *  - 纯 JS，不依赖 wx / 云开发，可被 Node 单测直接调用
 *  - 通过注入的 storage 持久化（小程序里用 wx storage，单测里用内存对象）
 *  - 复用 cloudfunctions/api/core 下的同一套纯逻辑（金额 / 定价 / 状态机 / 时段 / 打包 / 统计）
 *  - 与云端数据结构保持一致，切回 cloud 后页面代码无需改动
 */

const money = require('./core/money')
const dates = require('./core/dates')
const state = require('./core/state')
const pricing = require('./core/pricing')
const slotsCore = require('./core/slots')
const packingCore = require('./core/packing')
const statsCore = require('./core/stats')
const paymode = require('./core/paymode')
const { COLLECTIONS, COLLECTION_LIST } = require('./core/collections')
const { fail } = require('./core/errors')

const DB_KEY = 'ordering_local_db_v1'
const MERCHANT_ID = 'merchant_local'
const LOCAL_OPENID = 'local-demo-user'
const SHOP = {
  name: '今日菜单',
  pickupPlace: '店内前台自提',
  pickupNote: '请按所选时段到店内前台报订单号取餐'
}
const MAX_QTY_PER_ITEM = 20
const MAX_CART_LINES = 30
const MAX_REMARK_LENGTH = 60
const DEFAULT_SLOT_LIMIT = 20
const DEFAULT_SLOTS = [
  { id: 's1', label: '11:30-12:00', limit: 20 },
  { id: 's2', label: '12:00-12:30', limit: 20 },
  { id: 's3', label: '12:30-13:00', limit: 20 }
]
const MAX_PACKING_LIST = 2000

const COLLECTION_LABELS = {
  dishes: '菜品',
  menus: '每日菜单',
  orders: '订单',
  slot_counters: '时段名额计数',
  counters: '订单号计数器',
  merchant_admins: '商家白名单',
  settings: '配置',
  payment_records: '收款记录'
}

/** 8 个示例菜品：4 个分类、1 个规格菜、1 个售罄菜 */
const SEED_DISHES = [
  {
    _id: 'dish_hdg',
    name: '黄焖鸡米饭',
    category: '盖饭',
    priceCents: 2200,
    imageUrl: '',
    sortOrder: 1,
    onSale: true,
    soldOut: false,
    specs: [
      {
        id: 'g1',
        name: '辣度',
        required: true,
        options: [
          { id: 'g1o1', label: '不辣', priceDeltaCents: 0 },
          { id: 'g1o2', label: '微辣', priceDeltaCents: 0 },
          { id: 'g1o3', label: '中辣', priceDeltaCents: 0 }
        ]
      },
      {
        id: 'g2',
        name: '加料',
        required: false,
        options: [
          { id: 'g2o1', label: '加卤蛋', priceDeltaCents: 200 },
          { id: 'g2o2', label: '加青菜', priceDeltaCents: 300 }
        ]
      }
    ]
  },
  {
    _id: 'dish_tomato_egg',
    name: '番茄鸡蛋盖饭',
    category: '盖饭',
    priceCents: 1800,
    imageUrl: '',
    sortOrder: 2,
    onSale: true,
    soldOut: false,
    specs: []
  },
  {
    _id: 'dish_mushroom_chicken',
    name: '香菇滑鸡饭',
    category: '盖饭',
    priceCents: 2000,
    imageUrl: '',
    sortOrder: 3,
    onSale: true,
    soldOut: false,
    specs: []
  },
  {
    _id: 'dish_noodle',
    name: '牛肉面',
    category: '面食',
    priceCents: 2000,
    imageUrl: '',
    sortOrder: 4,
    onSale: true,
    soldOut: false,
    specs: [
      {
        id: 'g1',
        name: '面量',
        required: true,
        options: [
          { id: 'g1o1', label: '正常', priceDeltaCents: 0 },
          { id: 'g1o2', label: '加面', priceDeltaCents: 300 }
        ]
      }
    ]
  },
  {
    _id: 'dish_dumpling',
    name: '手工水饺（12只）',
    category: '面食',
    priceCents: 1600,
    imageUrl: '',
    sortOrder: 5,
    onSale: true,
    soldOut: false,
    specs: []
  },
  {
    _id: 'dish_cucumber',
    name: '凉拌黄瓜',
    category: '小食',
    priceCents: 800,
    imageUrl: '',
    sortOrder: 6,
    onSale: true,
    soldOut: true,
    specs: []
  },
  {
    _id: 'dish_egg',
    name: '卤蛋',
    category: '小食',
    priceCents: 300,
    imageUrl: '',
    sortOrder: 7,
    onSale: true,
    soldOut: false,
    specs: []
  },
  {
    _id: 'dish_drink',
    name: '自制酸梅汤',
    category: '饮品',
    priceCents: 500,
    imageUrl: '',
    sortOrder: 8,
    onSale: true,
    soldOut: false,
    specs: []
  }
]

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function pad4(n) {
  const s = String(n)
  return s.length >= 4 ? s : ('0000' + s).slice(-4)
}

function menuIdOf(dateKey) {
  return 'm_' + String(dateKey).replace(/-/g, '')
}

function counterDocId(menuId, slotId) {
  return menuId + '__' + slotId
}

function byCreatedDesc(a, b) {
  const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
  const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
  return (tb - ta) || String(b.orderNo).localeCompare(String(a.orderNo))
}

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

function merchantOrderView(order) {
  const totalCents = money.assertCents(order.totalCents || 0, '订单金额')
  return Object.assign({}, orderView(order), {
    items: itemViews(order.items),
    buyerOpenid: order.buyerOpenid || '',
    date: order.date,
    payChannelLabel: paymode.PAY_MODE_LABELS[order.payChannel] || '',
    transferredAtText: order.transferredAt ? dates.shanghaiDateTime(order.transferredAt) : '',
    confirmedAtText: order.confirmedAt ? dates.shanghaiDateTime(order.confirmedAt) : '',
    transferNote: order.transferNote || '',
    totalText: money.formatCents(totalCents)
  })
}

function createLocalBackend(options) {
  const opts = options || {}
  const storage = opts.storage
  if (!storage) throw new Error('local backend 需要注入 storage')
  const now = typeof opts.now === 'function' ? opts.now : function () { return new Date() }

  function stamp() {
    const value = now()
    return value instanceof Date ? new Date(value.getTime()) : new Date(value)
  }

  function emptyDb() {
    return {
      version: 1,
      seededAt: null,
      dishes: [],
      menus: {},
      orders: {},
      slotCounters: {},
      counters: {},
      settings: {},
      paymentRecords: {},
      merchantMode: false
    }
  }

  function normalizeDb(raw) {
    const base = raw && typeof raw === 'object' ? raw : {}
    return {
      version: 1,
      seededAt: base.seededAt || null,
      dishes: Array.isArray(base.dishes) ? base.dishes : [],
      menus: base.menus && typeof base.menus === 'object' ? base.menus : {},
      orders: base.orders && typeof base.orders === 'object' ? base.orders : {},
      slotCounters: base.slotCounters && typeof base.slotCounters === 'object' ? base.slotCounters : {},
      counters: base.counters && typeof base.counters === 'object' ? base.counters : {},
      settings: base.settings && typeof base.settings === 'object' ? base.settings : {},
      paymentRecords: base.paymentRecords && typeof base.paymentRecords === 'object' ? base.paymentRecords : {},
      merchantMode: base.merchantMode === true
    }
  }

  function buildSeed() {
    const at = stamp()
    const dateKey = dates.shanghaiDateKey(at)
    const menuId = menuIdOf(dateKey)
    const db = emptyDb()
    db.seededAt = at
    db.dishes = clone(SEED_DISHES).map((dish) =>
      Object.assign({}, dish, { merchantId: MERCHANT_ID, createdAt: at, updatedAt: at })
    )
    db.menus[menuId] = {
      _id: menuId,
      merchantId: MERCHANT_ID,
      date: dateKey,
      menuId,
      title: '今日菜单',
      dishIds: SEED_DISHES.map((dish) => dish._id),
      slots: [{ id: 's1', label: '11:30-12:00', limit: 20 }],
      published: true,
      createdAt: at,
      updatedAt: at,
      publishedBy: LOCAL_OPENID
    }
    db.slotCounters[counterDocId(menuId, 's1')] = {
      menuId,
      slotId: 's1',
      date: dateKey,
      label: '11:30-12:00',
      limit: 20,
      used: 0,
      createdAt: at,
      updatedAt: at
    }
    const payment = paymode.normalizePaymentSettings(paymode.DEFAULT_PAYMENT_SETTINGS)
    db.settings.payment = Object.assign({}, payment, {
      updatedAt: at,
      updatedBy: LOCAL_OPENID,
      createdAt: at
    })
    return db
  }

  function readDb() {
    let raw = null
    try {
      raw = storage.get(DB_KEY)
    } catch (err) {
      raw = null
    }
    if (!raw || typeof raw !== 'object') {
      const seeded = buildSeed()
      writeDb(seeded)
      return seeded
    }
    return normalizeDb(raw)
  }

  function writeDb(db) {
    storage.set(DB_KEY, db)
  }

  function getSettings(db) {
    return paymode.normalizePaymentSettings(db.settings.payment)
  }

  function payBranch(settings) {
    return paymode.resolvePayBranch({
      payMode: settings.payMode,
      wxpayEnabled: false,
      subMchId: '',
      envId: ''
    })
  }

  function paymentInfo(db) {
    const settings = getSettings(db)
    const branch = payBranch(settings)
    return {
      payMode: settings.payMode,
      payModeLabel: paymode.PAY_MODE_LABELS[settings.payMode],
      transfer: settings.transfer,
      usable: branch.usable,
      unusableReason: branch.usable ? '' : branch.message || '',
      jsapiConfigured: false
    }
  }

  function usedOf(db, menuId, slotId) {
    const counter = db.slotCounters[counterDocId(menuId, slotId)]
    return counter && Number.isInteger(counter.used) && counter.used >= 0 ? counter.used : 0
  }

  function today(db) {
    const at = stamp()
    const dateKey = dates.shanghaiDateKey(at)
    const menuId = menuIdOf(dateKey)
    const menu = db.menus[menuId]

    const base = {
      published: false,
      date: dateKey,
      dateLabel: dates.shanghaiDateLabel(dateKey),
      menuId,
      title: SHOP.name,
      shop: SHOP,
      payment: paymentInfo(db),
      slots: [],
      categories: [],
      totalDishes: 0
    }
    if (!menu || menu.published === false) return base

    const dishIds = Array.isArray(menu.dishIds) ? menu.dishIds : []
    const dishes = dishIds
      .map((id) => db.dishes.filter((dish) => dish._id === id)[0])
      .filter(Boolean)
      .filter((dish) => dish.onSale !== false)
      .sort((a, b) => {
        const ao = Number.isInteger(a.sortOrder) ? a.sortOrder : 0
        const bo = Number.isInteger(b.sortOrder) ? b.sortOrder : 0
        return (ao - bo) || String(a.name).localeCompare(String(b.name))
      })

    const categories = []
    const catIndex = {}
    for (const dish of dishes) {
      const name = dish.category || '其他'
      if (!catIndex[name]) {
        catIndex[name] = { name, dishes: [] }
        categories.push(catIndex[name])
      }
      catIndex[name].dishes.push(dishView(dish))
    }

    const slots = slotsCore.readSlots(menu.slots).map((slot) =>
      slotsCore.slotAvailability(slot, usedOf(db, menuId, slot.id))
    )

    return Object.assign({}, base, {
      published: true,
      title: menu.title || SHOP.name,
      slots,
      categories,
      totalDishes: dishes.length,
      menuVersion: menu.menuVersion || null,
      updatedAt: menu.updatedAt || null
    })
  }

  function getOrder(db, orderId) {
    const id = String(orderId || '')
    if (!id) fail('ORDER_ID_REQUIRED', '缺少订单号')
    const order = db.orders[id]
    if (!order) fail('ORDER_NOT_FOUND', '订单不存在')
    return order
  }

  function getOrderForUser(db, orderId, isMerchant) {
    const order = getOrder(db, orderId)
    if (order.buyerOpenid !== LOCAL_OPENID && !isMerchant) fail('FORBIDDEN', '无权查看该订单')
    return order
  }

  function releaseSlot(db, menuId, slotId, at) {
    const key = counterDocId(menuId, slotId)
    const counter = db.slotCounters[key]
    if (!counter || !Number.isInteger(counter.used) || counter.used <= 0) return
    counter.used -= 1
    counter.updatedAt = at
  }

  /** 顾客：下单（服务端/本地都只信菜品主数据重算价格） */
  function createOrder(db, payload) {
    const at = stamp()
    const dateKey = dates.shanghaiDateKey(at)
    const menuId = menuIdOf(dateKey)
    const menu = db.menus[menuId]
    if (!menu || menu.published === false) fail('MENU_NOT_PUBLISHED', '今日菜单尚未发布，暂时无法下单')

    const cartItems = Array.isArray(payload.cartItems) ? payload.cartItems : []
    const dishIds = []
    for (const item of cartItems) {
      const id = String((item && item.dishId) || '')
      if (id && dishIds.indexOf(id) < 0) dishIds.push(id)
    }
    const dishes = dishIds.map((id) => db.dishes.filter((dish) => dish._id === id)[0]).filter(Boolean)

    const priced = pricing.recalculateOrder({
      dishes,
      cartItems,
      menuDishIds: menu.dishIds || [],
      maxQtyPerItem: MAX_QTY_PER_ITEM,
      maxLines: MAX_CART_LINES
    })

    const slot = slotsCore.findSlot(menu, payload.slotId)
    const counterKey = counterDocId(menuId, slot.id)
    let counter = db.slotCounters[counterKey]
    if (!counter) {
      counter = {
        menuId,
        slotId: slot.id,
        date: dateKey,
        label: slot.label,
        limit: slot.limit,
        used: 0,
        createdAt: at,
        updatedAt: at
      }
      db.slotCounters[counterKey] = counter
    }
    const used = Number.isInteger(counter.used) && counter.used >= 0 ? counter.used : 0
    if (used >= slot.limit) fail('SLOT_FULL', `取餐时段「${slot.label}」已满，请选择其他时段`)
    counter.used = used + 1
    counter.limit = slot.limit
    counter.updatedAt = at

    const compact = dateKey.replace(/-/g, '')
    const seqKey = 'seq_' + compact
    const seq = (Number.isInteger(db.counters[seqKey]) ? db.counters[seqKey] : 0) + 1
    db.counters[seqKey] = seq
    const orderNo = compact + '-' + pad4(seq)

    const settings = getSettings(db)
    const remark = String(payload.remark || '').replace(/\s+/g, ' ').trim().slice(0, MAX_REMARK_LENGTH)
    const doc = {
      _id: orderNo,
      merchantId: MERCHANT_ID,
      orderNo,
      date: dateKey,
      menuId,
      buyerOpenid: LOCAL_OPENID,
      items: priced.items,
      totalCents: priced.totalCents,
      totalQty: priced.totalQty,
      status: state.STATUS.PENDING_PAY,
      payChannel: settings.payMode,
      transactionId: '',
      paidAt: null,
      transferredAt: null,
      transferNote: '',
      confirmedAt: null,
      confirmedBy: '',
      pickupSlot: { id: slot.id, label: slot.label },
      remark,
      packed: false,
      canceledAt: null,
      canceledBy: '',
      refunded: false,
      refundedCents: 0,
      statusHistory: [{ status: state.STATUS.PENDING_PAY, at, by: 'buyer' }],
      createdAt: at,
      updatedAt: at
    }
    db.orders[orderNo] = doc
    writeDb(db)

    return {
      orderId: orderNo,
      orderNo,
      status: doc.status,
      statusText: state.STATUS_TEXT[doc.status],
      totalCents: priced.totalCents,
      totalText: money.formatCents(priced.totalCents),
      totalQty: priced.totalQty,
      payChannel: settings.payMode,
      payChannelLabel: paymode.PAY_MODE_LABELS[settings.payMode],
      transfer: settings.transfer,
      slot: { id: slot.id, label: slot.label }
    }
  }

  function orderDetail(db, payload) {
    const isMerchant = payload.asMerchant === true
    const order = getOrderForUser(db, payload.orderId, isMerchant)
    const payment = paymentInfo(db)
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
      slot: {
        id: (order.pickupSlot && order.pickupSlot.id) || '',
        label: (order.pickupSlot && order.pickupSlot.label) || ''
      },
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
      confirmInfo: {
        operator: order.confirmedBy || '',
        at: order.confirmedAt ? dates.shanghaiDateTime(order.confirmedAt) : ''
      }
    }
  }

  function markTransferred(db, payload) {
    const order = getOrderForUser(db, payload.orderId, false)
    const settings = getSettings(db)
    if (settings.payMode !== paymode.PAY_MODES.TRANSFER) {
      fail('PAY_MODE_MISMATCH', '当前收款方式已变更，请刷新后重试')
    }
    const target = state.assertAction(order.status, 'transfer')
    const at = stamp()
    order.status = target
    order.payChannel = paymode.PAY_MODES.TRANSFER
    order.transferredAt = at
    order.transferNote = String(payload.note || '').trim().slice(0, 40)
    order.updatedAt = at
    order.statusHistory = (order.statusHistory || []).concat([{ status: target, at, by: 'buyer' }])
    writeDb(db)
    return { orderId: order._id, status: target, statusText: state.STATUS_TEXT[target] }
  }

  function cancelOrder(db, payload) {
    const isMerchant = payload.asMerchant === true
    const order = getOrderForUser(db, payload.orderId, isMerchant)
    const target = state.assertAction(order.status, 'cancel')
    const refunded = state.hasReceivedMoney(order)
    const at = stamp()
    order.status = target
    order.canceledAt = at
    order.canceledBy = isMerchant ? 'merchant' : 'buyer'
    order.refunded = refunded
    order.refundedCents = refunded ? money.assertCents(order.totalCents, '订单金额') : 0
    order.updatedAt = at
    order.statusHistory = (order.statusHistory || []).concat([
      { status: target, at, by: isMerchant ? 'merchant' : 'buyer' }
    ])
    releaseSlot(db, order.menuId, order.pickupSlot && order.pickupSlot.id, at)
    writeDb(db)
    return { orderId: order._id, status: target, statusText: state.STATUS_TEXT[target], refunded }
  }

  function reorder(db, payload) {
    const order = getOrderForUser(db, payload.orderId, false)
    const dateKey = dates.shanghaiDateKey(stamp())
    const menu = db.menus[menuIdOf(dateKey)]
    const menuDishIds = (menu && menu.dishIds) || []
    const items = (order.items || []).map((item) => {
      const dish = db.dishes.filter((row) => row._id === item.dishId)[0]
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

  function listDishes(db) {
    const dishes = db.dishes.slice().sort((a, b) => {
      const ao = Number.isInteger(a.sortOrder) ? a.sortOrder : 0
      const bo = Number.isInteger(b.sortOrder) ? b.sortOrder : 0
      const catA = String(a.category || '')
      const catB = String(b.category || '')
      return (ao - bo) || catA.localeCompare(catB) || String(a.name).localeCompare(String(b.name))
    })
    return { list: dishes.map(dishView), total: dishes.length }
  }

  function saveDish(db, payload) {
    const data = sanitizeDish(payload.dish)
    const dishId = String(payload.dishId || '')
    const at = stamp()
    if (dishId) {
      const existing = db.dishes.filter((dish) => dish._id === dishId)[0]
      if (!existing) fail('DISH_NOT_FOUND', '菜品不存在')
      Object.assign(existing, data, { updatedAt: at })
      writeDb(db)
      return { dishId, created: false }
    }
    const seq = (Number.isInteger(db.counters.dishSeq) ? db.counters.dishSeq : 0) + 1
    db.counters.dishSeq = seq
    const id = 'dish_local_' + String(seq)
    db.dishes.push(Object.assign({}, data, {
      _id: id,
      merchantId: MERCHANT_ID,
      createdAt: at,
      updatedAt: at
    }))
    writeDb(db)
    return { dishId: id, created: true }
  }

  function toggleDish(db, payload) {
    const field = String(payload.field || '')
    if (field !== 'onSale' && field !== 'soldOut') fail('FIELD_INVALID', '只支持切换 onSale / soldOut')
    const dishId = String(payload.dishId || '')
    const existing = db.dishes.filter((dish) => dish._id === dishId)[0]
    if (!existing) fail('DISH_NOT_FOUND', '菜品不存在')
    existing[field] = payload.value === true
    existing.updatedAt = stamp()
    writeDb(db)
    return { dishId, field, value: existing[field] }
  }

  function deleteDish(db, payload) {
    const dishId = String(payload.dishId || '')
    const existing = db.dishes.filter((dish) => dish._id === dishId)[0]
    if (!existing) fail('DISH_NOT_FOUND', '菜品不存在')
    db.dishes = db.dishes.filter((dish) => dish._id !== dishId)
    const dateKey = dates.shanghaiDateKey(stamp())
    const menu = db.menus[menuIdOf(dateKey)]
    if (menu && Array.isArray(menu.dishIds)) {
      menu.dishIds = menu.dishIds.filter((id) => id !== dishId)
      menu.updatedAt = stamp()
    }
    writeDb(db)
    return { dishId, removed: true }
  }

  function publishMenuInternal(db, input) {
    const at = stamp()
    const dateKey = String(input.date || dates.shanghaiDateKey(at))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) fail('DATE_INVALID', '日期格式必须为 YYYY-MM-DD')
    const menuId = menuIdOf(dateKey)
    const existing = db.menus[menuId]
    const slots = slotsCore.normalizeSlots(
      input.slots || (existing && existing.slots) || DEFAULT_SLOTS,
      DEFAULT_SLOT_LIMIT
    )

    let dishIds = null
    if (Array.isArray(input.dishIds) && input.dishIds.length) {
      const raw = []
      for (const id of input.dishIds) {
        const value = String(id)
        if (value && raw.indexOf(value) < 0) raw.push(value)
      }
      const found = raw.filter((id) => db.dishes.filter((dish) => dish._id === id)[0])
      if (found.length !== raw.length) fail('DISH_NOT_FOUND', '部分菜品已不存在，请刷新后重新选择')
      dishIds = raw
    } else if (existing && Array.isArray(existing.dishIds) && existing.dishIds.length) {
      dishIds = existing.dishIds
    } else {
      dishIds = db.dishes.filter((dish) => dish.onSale !== false).map((dish) => dish._id)
    }
    if (!dishIds.length) fail('DISH_EMPTY', '没有可发布的菜品，请先新增菜品')

    const title = (String(input.title || (existing && existing.title) || '今日菜单').trim() || '今日菜单').slice(0, 20)
    db.menus[menuId] = {
      _id: menuId,
      merchantId: MERCHANT_ID,
      date: dateKey,
      menuId,
      title,
      dishIds,
      slots,
      published: true,
      createdAt: (existing && existing.createdAt) || at,
      updatedAt: at,
      menuVersion: at.getTime ? at.getTime() : Date.now(),
      publishedBy: LOCAL_OPENID
    }

    for (const slot of slots) {
      const key = counterDocId(menuId, slot.id)
      const counter = db.slotCounters[key]
      if (counter) {
        counter.limit = slot.limit
        counter.label = slot.label
        counter.updatedAt = at
      } else {
        db.slotCounters[key] = {
          menuId,
          slotId: slot.id,
          date: dateKey,
          label: slot.label,
          limit: slot.limit,
          used: 0,
          createdAt: at,
          updatedAt: at
        }
      }
    }

    writeDb(db)
    return {
      menuId,
      date: dateKey,
      dateLabel: dates.shanghaiDateLabel(dateKey),
      title,
      dishCount: dishIds.length,
      slots
    }
  }

  function menuHistory(db) {
    const todayKey = dates.shanghaiDateKey(stamp())
    const list = Object.keys(db.menus)
      .map((key) => db.menus[key])
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 30)
      .map((menu) => ({
        date: menu.date,
        dateLabel: dates.shanghaiDateLabel(menu.date),
        title: menu.title,
        dishCount: (menu.dishIds || []).length,
        slotCount: (menu.slots || []).length,
        isToday: menu.date === todayKey
      }))
    return { list }
  }

  function menuDetail(db, payload) {
    const dateKey = String(payload.date || dates.shanghaiDateKey(stamp()))
    const menu = db.menus[menuIdOf(dateKey)]
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

  function merchantOrders(db, payload) {
    const dateKey = String(payload.date || dates.shanghaiDateKey(stamp()))
    const statuses = Array.isArray(payload.statuses) ? payload.statuses.filter((s) => state.STATUS_TEXT[s]) : []
    const list = Object.keys(db.orders)
      .map((key) => db.orders[key])
      .filter((order) => order.date === dateKey)
      .filter((order) => !statuses.length || statuses.indexOf(order.status) >= 0)
      .sort(byCreatedDesc)
      .map(merchantOrderView)
    return { date: dateKey, dateLabel: dates.shanghaiDateLabel(dateKey), list, total: list.length }
  }

  function transition(db, payload) {
    const action = String(payload.action || '')
    const allowed = ['accept', 'ready', 'complete', 'cancel']
    if (allowed.indexOf(action) < 0) fail('ACTION_NOT_ALLOWED', '商家端只支持 accept / ready / complete / cancel')
    const order = getOrder(db, payload.orderId)
    const target = state.assertAction(order.status, action)
    const at = stamp()
    order.status = target
    order.updatedAt = at
    order.statusHistory = (order.statusHistory || []).concat([{ status: target, at, by: 'merchant' }])
    if (target === state.STATUS.ACCEPTED) order.acceptedAt = at
    if (target === state.STATUS.READY) order.readyAt = at
    if (target === state.STATUS.COMPLETED) order.completedAt = at
    if (target === state.STATUS.CANCELED) {
      order.canceledAt = at
      order.canceledBy = 'merchant'
      order.refunded = state.hasReceivedMoney(order)
      order.refundedCents = order.refunded ? money.assertCents(order.totalCents, '订单金额') : 0
      releaseSlot(db, order.menuId, order.pickupSlot && order.pickupSlot.id, at)
    }
    writeDb(db)
    return merchantOrderView(order)
  }

  function confirmReceipt(db, payload) {
    const order = getOrder(db, payload.orderId)
    if (order.payChannel && order.payChannel !== paymode.PAY_MODES.TRANSFER) {
      fail('PAY_CHANNEL_MISMATCH', '该订单不是转账收款订单，无需人工确认')
    }
    const target = state.assertAction(order.status, 'confirm')
    const recordId = 'pr_' + order._id
    if (db.paymentRecords[recordId]) fail('ALREADY_CONFIRMED', '该订单已确认收款，请勿重复操作')

    const amountCents = money.assertCents(order.totalCents, '订单金额')
    const at = stamp()
    db.paymentRecords[recordId] = {
      _id: recordId,
      orderId: order._id,
      orderNo: order.orderNo,
      merchantId: MERCHANT_ID,
      date: order.date,
      amountCents,
      channel: paymode.PAY_MODES.TRANSFER,
      operatorOpenid: LOCAL_OPENID,
      at,
      note: String(payload.note || '').trim().slice(0, 100),
      createdAt: at
    }
    order.status = target
    order.paidAt = at
    order.confirmedAt = at
    order.confirmedBy = LOCAL_OPENID
    order.transactionId = 'TRANSFER-' + order.orderNo
    order.updatedAt = at
    order.statusHistory = (order.statusHistory || []).concat([{ status: target, at, by: 'merchant' }])
    writeDb(db)

    return {
      order: merchantOrderView(order),
      record: {
        recordId,
        amountCents,
        amountText: money.formatCents(amountCents),
        operatorOpenid: LOCAL_OPENID,
        atText: dates.shanghaiDateTime(at)
      }
    }
  }

  function packing(db, payload) {
    const dateKey = String(payload.date || dates.shanghaiDateKey(stamp()))
    const list = Object.keys(db.orders)
      .map((key) => db.orders[key])
      .filter((order) => order.date === dateKey)
      .filter((order) => state.UNFINISHED_PAID_STATUSES.indexOf(order.status) >= 0)
      .sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
        return ta - tb
      })
      .slice(0, MAX_PACKING_LIST)
    return packingCore.buildPackingList(list, {
      date: dateKey,
      dateLabel: dates.shanghaiDateLabel(dateKey)
    })
  }

  function setPacked(db, payload) {
    const order = getOrder(db, payload.orderId)
    if (state.UNFINISHED_PAID_STATUSES.indexOf(order.status) < 0) {
      fail('ORDER_NOT_PACKABLE', '只有已收款且未完成的订单可以标记打包')
    }
    const at = stamp()
    order.packed = payload.packed === true
    order.packedAt = order.packed ? at : null
    order.updatedAt = at
    writeDb(db)
    return { orderId: order._id, packed: order.packed }
  }

  function stats(db, payload) {
    const dateKey = String(payload.date || dates.shanghaiDateKey(stamp()))
    const list = Object.keys(db.orders)
      .map((key) => db.orders[key])
      .filter((order) => order.date === dateKey)
    const result = statsCore.buildDailyStats(list, { date: dateKey })
    result.dateLabel = dates.shanghaiDateLabel(dateKey)
    result.paymentRecords = Object.keys(db.paymentRecords)
      .map((key) => db.paymentRecords[key])
      .filter((record) => record.date === dateKey)
      .sort((a, b) => {
        const ta = a.at ? new Date(a.at).getTime() : 0
        const tb = b.at ? new Date(b.at).getTime() : 0
        return tb - ta
      })
      .slice(0, 50)
      .map((record) => ({
        orderNo: record.orderNo,
        amountCents: record.amountCents,
        amountText: money.formatCents(record.amountCents),
        channelLabel: paymode.PAY_MODE_LABELS[record.channel] || record.channel,
        atText: dates.shanghaiShortTime(record.at),
        operatorOpenid: record.operatorOpenid
      }))
    return result
  }

  function savePaymentSettings(db, payload) {
    if (payload.payMode !== undefined && !paymode.isPayMode(payload.payMode)) {
      fail('PAY_MODE_INVALID', '支付方式只能是 transfer / jsapi / mock')
    }
    const existing = getSettings(db)
    const merged = {
      payMode: payload.payMode !== undefined ? payload.payMode : existing.payMode,
      transfer: Object.assign({}, existing.transfer || {}, payload.transfer || {})
    }
    const normalized = paymode.normalizePaymentSettings(merged)
    const at = stamp()
    db.settings.payment = {
      payMode: normalized.payMode,
      transfer: normalized.transfer,
      updatedAt: at,
      updatedBy: LOCAL_OPENID,
      createdAt: (db.settings.payment && db.settings.payment.createdAt) || at
    }
    writeDb(db)
    const branch = payBranch(normalized)
    return {
      settings: normalized,
      payModeLabel: paymode.PAY_MODE_LABELS[normalized.payMode],
      usable: branch.usable,
      warning: branch.usable ? '' : branch.message || ''
    }
  }

  function getPaymentSettings(db) {
    const settings = getSettings(db)
    const branch = payBranch(settings)
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
      jsapiConfigured: false
    }
  }

  function mockPay(db, payload) {
    const settings = getSettings(db)
    if (settings.payMode !== paymode.PAY_MODES.MOCK) {
      fail('PAY_MODE_MISMATCH', '当前收款方式不是模拟支付，请刷新后重试')
    }
    const order = getOrderForUser(db, payload.orderId, false)
    if (order.status !== state.STATUS.PENDING_PAY) {
      fail('ORDER_NOT_PAYABLE', '订单当前状态不是「待付款」，无法支付')
    }
    const at = stamp()
    const transactionId = 'MOCK' + at.getTime()
    order.status = state.STATUS.PAID
    order.payChannel = paymode.PAY_MODES.MOCK
    order.transactionId = transactionId
    order.paidAt = at
    order.updatedAt = at
    order.statusHistory = (order.statusHistory || []).concat([{ status: state.STATUS.PAID, at, by: 'mock' }])
    writeDb(db)
    return {
      mode: paymode.PAY_MODES.MOCK,
      paid: true,
      orderId: order._id,
      status: state.STATUS.PAID,
      transactionId,
      totalCents: order.totalCents
    }
  }

  function identity(db) {
    const merchant = db.merchantMode === true
    return {
      openid: LOCAL_OPENID,
      isMerchant: merchant,
      envId: 'local',
      mode: 'local',
      merchantOpenidCount: merchant ? 1 : 0,
      adminCollectionReady: true,
      canSelfClaim: false,
      autoBootstrap: false
    }
  }

  function switchRole(db, payload) {
    db.merchantMode = payload.merchant === true
    writeDb(db)
    return identity(db)
  }

  function health(db) {
    const at = stamp()
    const dateKey = dates.shanghaiDateKey(at)
    const menu = db.menus[menuIdOf(dateKey)]
    const settings = getSettings(db)
    const counts = {
      dishes: db.dishes.length,
      menus: Object.keys(db.menus).length,
      orders: Object.keys(db.orders).length,
      slot_counters: Object.keys(db.slotCounters).length,
      counters: Object.keys(db.counters).length,
      merchant_admins: 1,
      settings: Object.keys(db.settings).length,
      payment_records: Object.keys(db.paymentRecords).length
    }
    return {
      ok: true,
      mode: 'local',
      envId: 'local',
      serverTimeText: dates.shanghaiDateTime(at),
      openid: LOCAL_OPENID,
      identity: identity(db),
      collections: COLLECTION_LIST.map((name) => ({
        name,
        label: COLLECTION_LABELS[name] || name,
        exists: true,
        total: counts[name] || 0,
        error: ''
      })),
      today: {
        date: dateKey,
        dateLabel: dates.shanghaiDateLabel(dateKey),
        menuId: menuIdOf(dateKey),
        menuPublished: !!(menu && menu.published !== false),
        menuTitle: (menu && menu.title) || '',
        dishCount: (menu && menu.dishIds ? menu.dishIds.length : 0)
      },
      payment: {
        payMode: settings.payMode,
        payModeLabel: paymode.PAY_MODE_LABELS[settings.payMode],
        usable: payBranch(settings).usable,
        unusableReason: payBranch(settings).usable ? '' : payBranch(settings).message || '',
        jsapiConfigured: false
      },
      config: { merchantId: MERCHANT_ID },
      note: '本地演示模式：数据保存在本机 storage，不会写入云数据库'
    }
  }

  function run(action, payload) {
    const input = payload || {}
    const db = readDb()

    switch (action) {
      case 'health':
        return health(db)
      case 'whoami':
        return identity(db)
      case 'merchant.switchRole':
        return switchRole(db, input)
      case 'merchant.claimSelf':
        db.merchantMode = true
        writeDb(db)
        return { isMerchant: true, claimed: true, openid: LOCAL_OPENID }

      // 顾客端
      case 'menu.today':
        return today(db)
      case 'settings.payment':
        return paymentInfo(db)
      case 'order.create':
        return createOrder(db, input)
      case 'order.list': {
        const page = Math.max(Number(input.page) || 1, 1)
        const size = 20
        const all = Object.keys(db.orders)
          .map((key) => db.orders[key])
          .filter((order) => order.buyerOpenid === LOCAL_OPENID)
          .sort(byCreatedDesc)
        const list = all.slice((page - 1) * size, page * size).map(orderView)
        return { page, list, hasMore: list.length === size }
      }
      case 'order.detail':
        return orderDetail(db, input)
      case 'order.markTransferred':
        return markTransferred(db, input)
      case 'order.cancel':
        return cancelOrder(db, input)
      case 'order.reorder':
        return reorder(db, input)

      // 商家端
      case 'merchant.checkAccess':
        return {
          isMerchant: db.merchantMode === true,
          bootstrapped: false,
          openid: LOCAL_OPENID,
          merchantId: MERCHANT_ID,
          canBootstrap: false
        }
      case 'merchant.listDishes':
        return listDishes(db)
      case 'merchant.saveDish':
        return saveDish(db, input)
      case 'merchant.toggleDish':
        return toggleDish(db, input)
      case 'merchant.deleteDish':
        return deleteDish(db, input)
      case 'merchant.publishMenu':
        return publishMenuInternal(db, input)
      case 'merchant.copyMenu': {
        const fromDate = String(input.fromDate || '')
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) fail('DATE_INVALID', '请选择要复制的历史菜单日期')
        const source = db.menus[menuIdOf(fromDate)]
        if (!source) fail('MENU_NOT_FOUND', '历史菜单不存在')
        return publishMenuInternal(db, {
          date: input.date || dates.shanghaiDateKey(stamp()),
          title: input.title || source.title,
          slots: source.slots,
          dishIds: source.dishIds
        })
      }
      case 'merchant.menuHistory':
        return menuHistory(db)
      case 'merchant.menuDetail':
        return menuDetail(db, input)
      case 'merchant.orders':
        return merchantOrders(db, input)
      case 'merchant.transition':
        return transition(db, input)
      case 'merchant.confirmReceipt':
        return confirmReceipt(db, input)
      case 'merchant.packing':
        return packing(db, input)
      case 'merchant.setPacked':
        return setPacked(db, input)
      case 'merchant.stats':
        return stats(db, input)
      case 'merchant.getPaymentSettings':
        return getPaymentSettings(db)
      case 'merchant.savePaymentSettings':
        return savePaymentSettings(db, input)

      // 支付
      case 'mockPay':
        return mockPay(db, input)
      case 'jsapiPay':
        fail('WXPAY_NOT_CONFIGURED', '本地演示模式未接入微信支付，请改用转账收款或在云端模式配置 cloudPay')
        break

      default:
        fail('UNKNOWN_ACTION', '本地演示模式不支持的接口：' + action)
    }
    return null
  }

  return {
    run,
    mode: 'local',
    storageKey: DB_KEY,
    openid: LOCAL_OPENID,
    reset() {
      storage.remove && storage.remove(DB_KEY)
    }
  }
}

module.exports = {
  DB_KEY,
  MERCHANT_ID,
  LOCAL_OPENID,
  SHOP,
  SEED_DISHES,
  COLLECTION_LABELS,
  createLocalBackend,
  sanitizeDish,
  dishView,
  orderView,
  itemViews,
  availableActions
}
