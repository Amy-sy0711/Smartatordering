'use strict'

const config = require('../config')
const { COLLECTIONS: COL } = require('../core/collections')
const { fail } = require('../core/errors')
const dates = require('../core/dates')
const money = require('../core/money')
const packingCore = require('../core/packing')
const slotsCore = require('../core/slots')
const state = require('../core/state')
const pickupCode = require('../core/pickup-code')
const statsCore = require('../core/stats')
const paymode = require('../core/paymode')
const dbLib = require('../lib/db')
const slotLib = require('../lib/slots')
const settingsLib = require('../lib/settings')
const identityLib = require('../lib/identity')
const auditLib = require('../lib/audit')
const exportCore = require('../core/export')
const menuHandler = require('./menu')
const orderHandler = require('./order')

async function requireMerchant(ctx, options) {
  return identityLib.requireMerchant(ctx, options)
}

function merchantIdOf(identity) {
  return identityLib.merchantIdOf(identity)
}

/** 商家入口准入检查；不再自动 bootstrap，商家关系由管理台维护 */
async function checkAccess(ctx) {
  const identity = ctx.identity || await identityLib.resolveIdentity(ctx)
  return {
    isMerchant: identity.isMerchant,
    role: identity.role,
    openid: identity.openid,
    merchantId: identity.merchantId,
    merchantName: identity.merchantName,
    merchantStatus: identity.merchantStatus,
    bootstrapped: false,
    canBootstrap: false
  }
}

/* ------------------------------ 菜品管理 ------------------------------ */

async function listDishes(ctx) {
  const identity = await requireMerchant(ctx)
  const merchantId = merchantIdOf(identity)
  const dishes = await dbLib.fetchAll(() =>
    ctx.db.collection(COL.DISHES).where({ merchantId }).orderBy('sortOrder', 'asc')
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
  const identity = await requireMerchant(ctx, { write: true, ownerOnly: true })
  const merchantId = merchantIdOf(identity)
  const payload = ctx.payload || {}
  const data = sanitizeDish(payload.dish)
  const dishId = String(payload.dishId || '')

  if (dishId) {
    const existing = await dbLib.getDocOrNull(ctx.db, COL.DISHES, dishId)
    if (!existing || existing.merchantId !== merchantId) fail('DISH_NOT_FOUND', '菜品不存在')
    await ctx.db.collection(COL.DISHES).doc(dishId).update({ data: Object.assign({}, data, { updatedAt: new Date() }) })
    return { dishId, created: false }
  }

  const res = await ctx.db.collection(COL.DISHES).add({
    data: Object.assign({}, data, {
      merchantId,
      createdAt: new Date(),
      updatedAt: new Date()
    })
  })
  return { dishId: res._id, created: true }
}

async function toggleDish(ctx) {
  const identity = await requireMerchant(ctx, { write: true, ownerOnly: true })
  const merchantId = merchantIdOf(identity)
  const payload = ctx.payload || {}
  const field = String(payload.field || '')
  if (field !== 'onSale' && field !== 'soldOut') fail('FIELD_INVALID', '只支持切换 onSale / soldOut')
  const dishId = String(payload.dishId || '')
  const existing = await dbLib.getDocOrNull(ctx.db, COL.DISHES, dishId)
  if (!existing || existing.merchantId !== merchantId) fail('DISH_NOT_FOUND', '菜品不存在')
  const value = payload.value === true
  await ctx.db.collection(COL.DISHES).doc(dishId).update({ data: { [field]: value, updatedAt: new Date() } })
  return { dishId, field, value }
}

async function deleteDish(ctx) {
  const identity = await requireMerchant(ctx, { write: true, ownerOnly: true })
  const merchantId = merchantIdOf(identity)
  const dishId = String((ctx.payload || {}).dishId || '')
  const existing = await dbLib.getDocOrNull(ctx.db, COL.DISHES, dishId)
  if (!existing || existing.merchantId !== merchantId) fail('DISH_NOT_FOUND', '菜品不存在')
  await ctx.db.collection(COL.DISHES).doc(dishId).remove()
  // 同步从今日菜单移除，避免菜单里出现幽灵菜品
  const dateKey = dates.shanghaiDateKey()
  await ctx.db
    .collection(COL.MENUS)
    .doc(menuHandler.menuIdOf(dateKey, merchantId))
    .update({ data: { dishIds: ctx._.pull(dishId), updatedAt: new Date(), menuVersion: Date.now() } })
    .catch(() => {})
  return { dishId, removed: true }
}

/* ------------------------------ 分类管理 ------------------------------ */

function cleanCategoryName(raw) {
  const name = String(raw === undefined || raw === null ? '' : raw).trim()
  if (!name || name.length > 12) fail('CATEGORY_NAME_INVALID', '分类名称需为 1-12 个字符')
  return name
}

async function listCategories(ctx) {
  const identity = await requireMerchant(ctx)
  const merchantId = merchantIdOf(identity)
  const docs = await dbLib.fetchAll(() =>
    ctx.db.collection(COL.CATEGORIES).where({ merchantId }).orderBy('sort', 'asc')
  )
  docs.sort((a, b) => (Number(a.sort) || 0) - (Number(b.sort) || 0) || String(a.name).localeCompare(String(b.name)))
  return {
    list: docs.map((doc) => ({
      categoryId: doc._id,
      name: doc.name || '',
      sort: Number.isInteger(doc.sort) ? doc.sort : 0,
      enabled: doc.enabled !== false
    }))
  }
}

async function saveCategory(ctx) {
  const identity = await requireMerchant(ctx, { write: true, ownerOnly: true })
  const merchantId = merchantIdOf(identity)
  const payload = ctx.payload || {}
  const categoryId = String(payload.categoryId || '')
  const name = cleanCategoryName(payload.name)
  const docs = await dbLib.fetchAll(() => ctx.db.collection(COL.CATEGORIES).where({ merchantId }))
  const duplicate = docs.filter((doc) => String(doc.name || '').trim() === name && doc._id !== categoryId)
  if (duplicate.length) fail('CATEGORY_DUPLICATED', '分类名称已存在')

  let sort = Number(payload.sort)
  if (!Number.isFinite(sort)) {
    sort = docs.reduce((max, doc) => Math.max(max, Number(doc.sort) || 0), 0) + 1
  }
  sort = Math.floor(sort)
  const enabled = payload.enabled !== false

  if (categoryId) {
    const existing = await dbLib.getDocOrNull(ctx.db, COL.CATEGORIES, categoryId)
    if (!existing || existing.merchantId !== merchantId) fail('CATEGORY_NOT_FOUND', '分类不存在')
    await ctx.db.collection(COL.CATEGORIES).doc(categoryId).update({
      data: { name, sort, enabled, updatedAt: new Date() }
    })
    if (existing.name && existing.name !== name) {
      const dishes = await dbLib.fetchAll(() =>
        ctx.db.collection(COL.DISHES).where({ merchantId, category: existing.name })
      )
      for (const dish of dishes) {
        await ctx.db.collection(COL.DISHES).doc(dish._id).update({ data: { category: name, updatedAt: new Date() } })
      }
      return { categoryId, created: false, movedDishes: dishes.length }
    }
    return { categoryId, created: false, movedDishes: 0 }
  }

  const res = await ctx.db.collection(COL.CATEGORIES).add({
    data: { merchantId, name, sort, enabled, createdAt: new Date(), updatedAt: new Date() }
  })
  return { categoryId: res._id, created: true }
}

async function deleteCategory(ctx) {
  const identity = await requireMerchant(ctx, { write: true, ownerOnly: true })
  const merchantId = merchantIdOf(identity)
  const categoryId = String((ctx.payload || {}).categoryId || '')
  const existing = await dbLib.getDocOrNull(ctx.db, COL.CATEGORIES, categoryId)
  if (!existing || existing.merchantId !== merchantId) fail('CATEGORY_NOT_FOUND', '分类不存在')
  const dishes = await dbLib.fetchAll(() =>
    ctx.db.collection(COL.DISHES).where({ merchantId, category: existing.name })
  )
  for (const dish of dishes) {
    await ctx.db.collection(COL.DISHES).doc(dish._id).update({ data: { category: '其他', updatedAt: new Date() } })
  }
  await ctx.db.collection(COL.CATEGORIES).doc(categoryId).remove()
  return { categoryId, removed: true, movedDishes: dishes.length }
}

/* ------------------------------ 员工管理（商家后台） ------------------------------ */

const STAFF_OPENID_RE = /^[A-Za-z0-9_-]{6,64}$/

async function staffList(ctx) {
  const identity = await requireMerchant(ctx, { ownerOnly: true })
  const merchantId = merchantIdOf(identity)
  const docs = await dbLib.fetchAll(() => ctx.db.collection(COL.MERCHANT_STAFF).where({ merchantId }))
  return {
    merchantId,
    list: docs.map((doc) => ({
      openid: doc._id,
      role: doc.role === 'owner' ? 'owner' : 'staff',
      name: doc.name || '',
      createdAt: doc.createdAt || null
    }))
  }
}

async function staffBind(ctx) {
  const identity = await requireMerchant(ctx, { write: true, ownerOnly: true })
  const merchantId = merchantIdOf(identity)
  const payload = ctx.payload || {}
  const openid = String(payload.openid || '').trim()
  if (!STAFF_OPENID_RE.test(openid)) fail('OPENID_INVALID', '请填写有效的小程序 openid')
  if (openid === identity.openid) fail('STAFF_SELF', '当前账号已经是店主，无需重复绑定')

  const existing = await dbLib.getDocOrNull(ctx.db, COL.MERCHANT_STAFF, openid)
  if (existing && existing.merchantId && existing.merchantId !== merchantId) {
    fail('STAFF_OTHER_MERCHANT', '该 openid 已绑定其他商家，请先在平台后台解绑')
  }
  const role = payload.role === 'owner' ? 'owner' : 'staff'
  const merchantIds = Array.isArray(existing && existing.merchantIds) ? existing.merchantIds.slice() : []
  if (merchantIds.indexOf(merchantId) < 0) merchantIds.push(merchantId)
  await ctx.db.collection(COL.MERCHANT_STAFF).doc(openid).set({
    data: {
      openid,
      merchantId,
      merchantIds,
      role,
      name: String(payload.name || '').trim().slice(0, 20) || (role === 'owner' ? '店主' : '员工'),
      createdAt: (existing && existing.createdAt) || new Date(),
      updatedAt: new Date()
    }
  })
  return { openid, merchantId, role }
}

async function staffUnbind(ctx) {
  const identity = await requireMerchant(ctx, { write: true, ownerOnly: true })
  const merchantId = merchantIdOf(identity)
  const openid = String((ctx.payload || {}).openid || '').trim()
  if (!STAFF_OPENID_RE.test(openid)) fail('OPENID_INVALID', 'openid 不合法')
  const existing = await dbLib.getDocOrNull(ctx.db, COL.MERCHANT_STAFF, openid)
  if (!existing || existing.merchantId !== merchantId) fail('STAFF_NOT_FOUND', '该 openid 不属于当前商家')
  if (existing.role === 'owner') fail('STAFF_OWNER_PROTECTED', '不能解绑店主账号')
  await ctx.db.collection(COL.MERCHANT_STAFF).doc(openid).remove()
  return { openid, removed: true }
}

/* ------------------------------ 导出（仅本租户） ------------------------------ */

async function exportOrders(ctx) {
  const identity = await requireMerchant(ctx)
  const merchantId = merchantIdOf(identity)
  const payload = ctx.payload || {}
  const dateKey = String(payload.date || dates.shanghaiDateKey())
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) fail('DATE_INVALID', '日期格式必须为 YYYY-MM-DD')

  const orders = await dbLib.fetchAll(() =>
    ctx.db.collection(COL.ORDERS).where({ merchantId, date: dateKey }).orderBy('createdAt', 'asc')
  )
  const result = exportCore.buildOrdersCsv(orders, merchantId)
  // 审计只记录条数与操作者，绝不写入订单内容
  await auditLib.writeAudit(ctx.db, {
    actorType: 'merchant',
    actorId: identity.openid || merchantId,
    action: 'merchant.exportOrders',
    merchantId,
    result: 'ok',
    code: 'OK',
    source: 'merchant-console'
  })
  return { date: dateKey, count: result.count, csv: result.csv }
}

/* ------------------------------ 菜单发布 ------------------------------ */

async function allOnSaleDishIds(ctx, merchantId) {
  const dishes = await dbLib.fetchAll(() => ctx.db.collection(COL.DISHES).where({ merchantId }))
  return dishes.filter((dish) => dish.onSale !== false).map((dish) => dish._id)
}

async function publishMenuInternal(ctx, options) {
  const opts = options || {}
  const merchantId = String(opts.merchantId || (ctx.identity && ctx.identity.merchantId) || config.DEFAULT_MERCHANT_ID)
  const dateKey = opts.date || dates.shanghaiDateKey()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) fail('DATE_INVALID', '日期格式必须为 YYYY-MM-DD')

  const menuId = menuHandler.menuIdOf(dateKey, merchantId)
  const existing = await dbLib.getDocOrNull(ctx.db, COL.MENUS, menuId)
  if (existing && existing.merchantId && existing.merchantId !== merchantId) {
    fail('FORBIDDEN', '不能修改其他商家的菜单')
  }
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
      ctx.db.collection(COL.DISHES).where({ merchantId, _id: ctx._.in(raw) })
    )
    if (found.length !== raw.length) fail('DISH_NOT_FOUND', '部分菜品已不存在，请刷新后重新选择')
    dishIds = raw
  } else if (existing && Array.isArray(existing.dishIds) && existing.dishIds.length) {
    dishIds = existing.dishIds
  } else {
    dishIds = await allOnSaleDishIds(ctx, merchantId)
  }
  if (!dishIds.length) fail('DISH_EMPTY', '没有可发布的菜品，请先新增菜品')

  const title = (String(opts.title || (existing && existing.title) || '今日菜单').trim() || '今日菜单').slice(0, 20)

  await ctx.db.collection(COL.MENUS).doc(menuId).set({
    data: {
      merchantId,
      date: dateKey,
      menuId,
      title,
      dishIds,
      slots,
      published: true,
      createdAt: (existing && existing.createdAt) || new Date(),
      updatedAt: new Date(),
      menuVersion: Date.now(),
      publishedBy: ctx.openid
    }
  })

  for (const slot of slots) {
    await slotLib.ensureSlotCounter(ctx.db, menuId, dateKey, slot)
  }

  return { menuId, date: dateKey, dateLabel: dates.shanghaiDateLabel(dateKey), title, dishCount: dishIds.length, slots }
}

async function publishMenu(ctx) {
  const identity = await requireMerchant(ctx, { write: true, ownerOnly: true })
  const payload = ctx.payload || {}
  return publishMenuInternal(ctx, {
    merchantId: merchantIdOf(identity),
    date: payload.date,
    title: payload.title,
    slots: payload.slots,
    dishIds: payload.dishIds
  })
}

/** 从历史菜单一键复制（复制菜品集合 + 取餐时段） */
async function copyMenu(ctx) {
  const identity = await requireMerchant(ctx, { write: true, ownerOnly: true })
  const merchantId = merchantIdOf(identity)
  const payload = ctx.payload || {}
  const fromDate = String(payload.fromDate || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) fail('DATE_INVALID', '请选择要复制的历史菜单日期')
  const source = await dbLib.getDocOrNull(ctx.db, COL.MENUS, menuHandler.menuIdOf(fromDate, merchantId))
  if (!source) fail('MENU_NOT_FOUND', '历史菜单不存在')

  return publishMenuInternal(ctx, {
    merchantId,
    date: payload.date || dates.shanghaiDateKey(),
    title: payload.title || source.title,
    slots: source.slots,
    dishIds: source.dishIds
  })
}

async function menuHistory(ctx) {
  const identity = await requireMerchant(ctx)
  const merchantId = merchantIdOf(identity)
  const res = await ctx.db
    .collection(COL.MENUS)
    .where({ merchantId })
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
  const identity = await requireMerchant(ctx)
  const merchantId = merchantIdOf(identity)
  const dateKey = String((ctx.payload || {}).date || dates.shanghaiDateKey())
  const menu = await dbLib.getDocOrNull(ctx.db, COL.MENUS, menuHandler.menuIdOf(dateKey, merchantId))
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
  const identity = await requireMerchant(ctx)
  const merchantId = merchantIdOf(identity)
  const payload = ctx.payload || {}
  const dateKey = String(payload.date || dates.shanghaiDateKey())
  const where = { merchantId, date: dateKey }
  let statusFilter = null
  if (Array.isArray(payload.statuses) && payload.statuses.length) {
    const valid = payload.statuses.filter((s) => state.STATUS_TEXT[s])
    if (valid.length) {
      where.status = ctx._.in(valid)
      statusFilter = valid
    }
  }
  const listData = await dbLib.fetchAll(() =>
    ctx.db.collection(COL.ORDERS).where(where).orderBy('createdAt', 'desc')
  )
  // 多租户改造前的旧订单没有 merchantId 字段，默认商家的看板需要把它们一并带回
  const legacySameDay = merchantId === config.DEFAULT_MERCHANT_ID
    ? await fetchLegacyOrders(ctx, dateKey, statusFilter)
    : []
  legacySameDay.forEach((order) => listData.push(order))
  listData.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
  // 历史遗留的待收款订单（换了日期就看不见按钮 → 商家无法确认收款），
  // 无论筛选哪一天，都把其他日期的 pending_pay / pending_confirm 一并带回，最多 100 单。
  const unpaidStatuses = [state.STATUS.PENDING_PAY, state.STATUS.PENDING_CONFIRM]
  const unpaid = where.status
    ? []
    : await dbLib.fetchAll(() =>
        ctx.db
          .collection(COL.ORDERS)
          .where({ merchantId, status: ctx._.in(unpaidStatuses) })
          .orderBy('createdAt', 'desc')
      )
  const legacyUnpaid = where.status || merchantId !== config.DEFAULT_MERCHANT_ID
    ? []
    : await fetchLegacyOrders(ctx, null, unpaidStatuses)
  const seen = {}
  listData.forEach((order) => { seen[order._id] = true })
  const stale = unpaid
    .concat(legacyUnpaid)
    .filter((order) => !seen[order._id] && order.date !== dateKey)
    .slice(0, 100)
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
  const merged = stale.concat(listData)
  return {
    date: dateKey,
    dateLabel: dates.shanghaiDateLabel(dateKey),
    list: merged.map((order) => Object.assign(merchantOrderView(order), { isStale: order.date !== dateKey })),
    staleCount: stale.length,
    total: merged.length
  }
}

/** 旧订单没有 merchantId 字段：默认商家按「字段不存在」查一次，失败不影响主流程 */
async function fetchLegacyOrders(ctx, dateKey, statuses) {
  const where = { merchantId: ctx._.exists(false) }
  if (dateKey) where.date = dateKey
  if (statuses && statuses.length) where.status = ctx._.in(statuses)
  try {
    return await dbLib.fetchAll(() => ctx.db.collection(COL.ORDERS).where(where))
  } catch (err) {
    return []
  }
}

async function getOrderOrThrow(ctx, orderId, merchantId) {
  const id = String(orderId || '')
  if (!id) fail('ORDER_ID_REQUIRED', '缺少订单号')
  if (!merchantId) fail('MERCHANT_REQUIRED', '缺少商家信息')
  // 按 _id 取后校验租户，杜绝跨租户读取；旧订单没有 merchantId 字段，按默认商家处理
  const order = await dbLib.getDocOrNull(ctx.db, COL.ORDERS, id)
  if (!order) fail('ORDER_NOT_FOUND', '订单不存在')
  order.merchantId = order.merchantId || config.DEFAULT_MERCHANT_ID
  if (order.merchantId !== merchantId) fail('ORDER_NOT_FOUND', '订单不存在')
  return order
}

/** 商家推进状态：出餐（生成取餐码）/ 完成 / 取消；accept 仅为历史数据兼容（非法流转直接拒绝） */
async function transition(ctx) {
  const identity = await requireMerchant(ctx, { write: true })
  const merchantId = merchantIdOf(identity)
  const payload = ctx.payload || {}
  const action = String(payload.action || '')
  const allowed = ['accept', 'ready', 'complete', 'cancel']
  if (allowed.indexOf(action) < 0) fail('ACTION_NOT_ALLOWED', '商家端只支持 accept / ready / complete / cancel')

  const order = await getOrderOrThrow(ctx, payload.orderId, merchantId)
  const target = state.assertAction(order.status, action)
  const now = new Date()
  const patch = {
    status: target,
    updatedAt: now,
    statusHistory: ctx._.push({ status: target, at: now, by: 'merchant' })
  }
  if (target === state.STATUS.ACCEPTED) patch.acceptedAt = now
  if (target === state.STATUS.READY) {
    patch.readyAt = now
    // 出餐完成 → 待取餐：原子分配当日取餐码；已有码则复用（幂等，不重复占号）
    if (order.pickupCode) {
      patch.pickupCode = order.pickupCode
      patch.pickupCodeSeq = order.pickupCodeSeq || 0
      patch.pickupCodeDate = order.pickupCodeDate || order.date
    } else {
      const allocated = await pickupCode.nextPickupCode(
        pickupCode.dbStore(ctx.db, ctx._, COL.COUNTERS),
        merchantId,
        order.date || dates.shanghaiDateKey()
      )
      patch.pickupCode = allocated.code
      patch.pickupCodeSeq = allocated.seq
      patch.pickupCodeDate = order.date
      patch.pickupCodeAt = now
      if (allocated.warning) patch.pickupCodeWarning = allocated.warning
    }
  }
  if (target === state.STATUS.COMPLETED) patch.completedAt = now
  if (target === state.STATUS.CANCELED) {
    patch.canceledAt = now
    patch.canceledBy = 'merchant'
    patch.refunded = state.hasReceivedMoney(order)
    patch.refundedCents = patch.refunded ? money.assertCents(order.totalCents, '订单金额') : 0
  }

  const res = await ctx.db
    .collection(COL.ORDERS)
    .where({ _id: order._id, status: order.status, merchantId })
    .update({ data: patch })
  if (!res.stats || !res.stats.updated) fail('CONCURRENT_MODIFIED', '订单状态已被更新，请刷新后重试')

  if (target === state.STATUS.CANCELED) {
    await slotLib.releaseSlot(ctx.db, ctx._, order.menuId, order.pickupSlot && order.pickupSlot.id).catch(() => {})
  }

  const fresh = await getOrderOrThrow(ctx, order._id, merchantId)
  return merchantOrderView(fresh)
}

/**
 * 商家确认已收款（pending_pay / pending_confirm → paid），并落一条收款记录用于对账。
 * 收款记录 _id 固定为 pr_<orderId>，天然防止重复确认。
 */
async function confirmReceipt(ctx) {
  const identity = await requireMerchant(ctx, { write: true })
  const merchantId = merchantIdOf(identity)
  const payload = ctx.payload || {}
  const order = await getOrderOrThrow(ctx, payload.orderId, merchantId)

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
        merchantId,
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
    .where({ _id: order._id, status: order.status, merchantId })
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

  const fresh = await getOrderOrThrow(ctx, order._id, merchantId)
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
  const identity = await requireMerchant(ctx)
  const merchantId = merchantIdOf(identity)
  const dateKey = String((ctx.payload || {}).date || dates.shanghaiDateKey())
  const listData = await dbLib.fetchAll(() =>
    ctx.db
      .collection(COL.ORDERS)
      .where({
        merchantId,
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
  const identity = await requireMerchant(ctx, { write: true })
  const merchantId = merchantIdOf(identity)
  const payload = ctx.payload || {}
  const order = await getOrderOrThrow(ctx, payload.orderId, merchantId)
  if (state.UNFINISHED_PAID_STATUSES.indexOf(order.status) < 0) {
    fail('ORDER_NOT_PACKABLE', '只有已收款且未完成的订单可以标记打包')
  }
  const packed = payload.packed === true
  const res = await ctx.db
    .collection(COL.ORDERS)
    .where({ _id: order._id, merchantId })
    .update({ data: { packed, packedAt: packed ? new Date() : null, updatedAt: new Date() } })
  if (!res.stats || !res.stats.updated) fail('CONCURRENT_MODIFIED', '订单状态已被更新，请刷新后重试')
  return { orderId: order._id, packed }
}

async function stats(ctx) {
  const identity = await requireMerchant(ctx)
  const merchantId = merchantIdOf(identity)
  const dateKey = String((ctx.payload || {}).date || dates.shanghaiDateKey())
  const listData = await dbLib.fetchAll(() =>
    ctx.db.collection(COL.ORDERS).where({ merchantId, date: dateKey })
  )
  const result = statsCore.buildDailyStats(listData, { date: dateKey })
  result.dateLabel = dates.shanghaiDateLabel(dateKey)

  const recordRes = await ctx.db
    .collection(COL.PAYMENT_RECORDS)
    .where({ merchantId, date: dateKey })
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
  const identity = await requireMerchant(ctx, { write: true, ownerOnly: true })
  const merchantId = merchantIdOf(identity)
  const saved = await settingsLib.savePaymentSettings(ctx.db, ctx.payload || {}, ctx.openid, merchantId)
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
  const identity = await requireMerchant(ctx)
  const merchantId = merchantIdOf(identity)
  const settings = await settingsLib.getPaymentSettings(ctx.db, merchantId)
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

/** 启动身份识别：返回 openid + 角色 + 当前商家（不做任何写入） */
async function whoami(ctx) {
  const identity = ctx.identity || await identityLib.resolveIdentity(ctx)
  // 只返回身份与商家状态；环境 ID、集合名、白名单数量等运维细节不向商家/顾客暴露
  return {
    openid: identity.openid || '',
    isMerchant: identity.isMerchant && identity.role !== 'admin',
    role: identity.role,
    merchantId: identity.merchantId,
    merchantName: identity.merchantName,
    merchantStatus: identity.merchantStatus,
    merchantIds: identity.merchantIds || [],
    mode: 'cloud',
    canSelfClaim: false,
    autoBootstrap: false
  }
}

/** 一次性自助成为默认商家店主（默认关闭；正式环境请用管理台绑定） */
async function claimSelf(ctx) {
  const payload = ctx.payload || {}
  if (payload.confirm !== true) fail('CONFIRM_REQUIRED', '请手动确认将当前 openid 设为商家')
  if (!config.ALLOW_SELF_CLAIM) fail('SELF_CLAIM_DISABLED', '自助成为商家已关闭，请让管理员在管理台绑定 openid')
  if (!ctx.openid) fail('NO_OPENID', '未获取到 openid，请在小程序内使用')

  const merchantId = config.DEFAULT_MERCHANT_ID
  const merchant = await identityLib.getMerchantDoc(ctx.db, merchantId)
  if (merchant && merchant.status === 'disabled') fail('MERCHANT_DISABLED', '商家已停用')
  await ctx.db.collection(COL.MERCHANT_STAFF).doc(ctx.openid).set({
    data: {
      openid: ctx.openid,
      merchantId,
      merchantIds: [merchantId],
      role: 'owner',
      name: '店主',
      createdAt: new Date()
    }
  })
  return { isMerchant: true, claimed: true, openid: ctx.openid, merchantId, role: 'owner' }
}

module.exports = {
  whoami,
  claimSelf,
  checkAccess,
  listDishes,
  saveDish,
  toggleDish,
  deleteDish,
  listCategories,
  saveCategory,
  deleteCategory,
  staffList,
  staffBind,
  staffUnbind,
  exportOrders,
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
