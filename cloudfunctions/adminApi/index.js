'use strict'

/**
 * 平台运营后台云函数（给系统运营者，即 SaaS 平台方）。
 *
 * 硬边界：本函数只处理租户元信息、计数、状态、配置、审计与「按 ID 的盲修复操作」。
 * 绝不返回订单内容、菜品内容、顾客信息、营收明细、备注、手机号、地址。
 * 禁止新增 listOrders / listDishes / getOrderDetail / exportOrders 这类 action。
 */

const cloud = require('wx-server-sdk')
const security = require('./core/security')
const policy = require('./core/policy')
const audit = require('./core/audit')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const COL = {
  MERCHANTS: 'merchants',
  STAFF: 'merchant_staff',
  ADMINS: 'admins',
  AUDIT_LOGS: 'audit_logs',
  ERROR_LOGS: 'error_logs',
  CATEGORIES: 'categories',
  DISHES: 'dishes',
  MENUS: 'menus',
  ORDERS: 'orders',
  SLOT_COUNTERS: 'slot_counters',
  COUNTERS: 'counters',
  SETTINGS: 'settings',
  PAYMENT_RECORDS: 'payment_records',
  LEGACY: 'merchant_admins'
}

const COLLECTION_LABELS = {
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
  audit_logs: '审计日志',
  error_logs: '错误日志',
  settings: '配置',
  payment_records: '收款记录'
}

const DEFAULT_MERCHANT_ID = 'merchant_001'
const MERCHANT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const OPENID_RE = /^[A-Za-z0-9_-]{6,64}$/

/** 需要落审计日志的写操作 */
const AUDITED_ACTIONS = [
  'merchant.create',
  'merchant.update',
  'merchant.setStatus',
  'merchant.setFlags',
  'merchant.resetPassword',
  'staff.bind',
  'staff.unbind',
  'repair.rebuildIndexes',
  'repair.seedDefaults',
  'repair.cleanOrphans',
  'repair.resetStaff',
  'repair.revokeTokens',
  'repair.refreshMenuCache',
  'repair.resendPaymentCallback',
  'admin.changePassword'
]

function ok(data) {
  return { code: 0, data }
}

function fail(code, message) {
  return { code, message }
}

function shanghaiDateKey(date) {
  const base = date || new Date()
  return new Date(base.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function menuIdOf(dateKey, merchantId) {
  const compact = String(dateKey || '').replace(/-/g, '')
  const mid = String(merchantId || DEFAULT_MERCHANT_ID)
  return mid === DEFAULT_MERCHANT_ID ? 'm_' + compact : 'm_' + mid + '_' + compact
}

function paymentDocId(merchantId) {
  const mid = String(merchantId || DEFAULT_MERCHANT_ID)
  return mid === DEFAULT_MERCHANT_ID ? 'payment' : 'payment_' + mid
}

async function fetchAll(name, where) {
  const query = where ? db.collection(name).where(where) : db.collection(name)
  const res = await query.limit(1000).get()
  return (res && res.data) || []
}

async function getDoc(name, id) {
  try {
    const res = await db.collection(name).doc(id).get()
    return (res && res.data) || null
  } catch (err) {
    return null
  }
}

/** 只读取支付模式字段（字段投影），不读取转账账号等商家收款明细 */
async function getPayMode(merchantId) {
  try {
    const res = await db
      .collection(COL.SETTINGS)
      .where({ _id: paymentDocId(merchantId) })
      .field({ payMode: true })
      .limit(1)
      .get()
    const doc = res && res.data && res.data[0]
    return (doc && String(doc.payMode || 'transfer')) || 'transfer'
  } catch (err) {
    return 'transfer'
  }
}

async function countWhere(name, where) {
  try {
    const res = await db.collection(name).where(where).count()
    return (res && res.total) || 0
  } catch (err) {
    return 0
  }
}

async function countCollection(name) {
  try {
    const res = await db.collection(name).count()
    return { exists: true, total: (res && res.total) || 0 }
  } catch (err) {
    return { exists: false, total: 0 }
  }
}

function authorize(event) {
  const payload = (event && event.payload) || {}
  const token = payload.token || (event && event.token)
  const result = security.verifyToken(token)
  if (!result.ok) {
    const err = new Error(result.message)
    err.code = result.code
    throw err
  }
  return result.payload
}

/* ------------------------------ 租户管理 ------------------------------ */

async function merchantList(payload) {
  const search = String(payload.search || '').trim().toLowerCase()
  const status = String(payload.status || '').trim()
  let list = await fetchAll(COL.MERCHANTS)
  if (search) {
    list = list.filter(
      (item) =>
        String(item._id || '').toLowerCase().indexOf(search) >= 0 ||
        String(item.name || '').toLowerCase().indexOf(search) >= 0
    )
  }
  if (status === 'active' || status === 'disabled') {
    list = list.filter((item) => (item.status || 'active') === status)
  }
  const today = shanghaiDateKey()
  const result = []
  for (const merchant of list) {
    const merchantId = merchant._id
    const todayOrderCount = await countWhere(COL.ORDERS, { merchantId, date: today })
    const staffCount = await countWhere(COL.STAFF, { merchantId })
    result.push({
      merchantId,
      name: merchant.name || '',
      status: merchant.status || 'active',
      contact: merchant.contact || '',
      plan: merchant.plan || 'basic',
      expiresAt: merchant.expiresAt || null,
      flags: merchant.flags || {},
      loginUsername: merchant.loginUsername || merchantId,
      hasPassword: !!merchant.passwordHash,
      settingsRef: merchant.settingsRef || '',
      createdAt: merchant.createdAt || null,
      updatedAt: merchant.updatedAt || null,
      todayOrderCount,
      staffCount
    })
  }
  result.sort((a, b) => String(a.merchantId).localeCompare(String(b.merchantId)))
  return { date: today, list: result, total: result.length }
}

async function merchantCreate(payload) {
  const name = String(payload.name || '').trim()
  if (!name || name.length > 20) return fail('MERCHANT_NAME_INVALID', '商家名称需为 1-20 个字符')
  let merchantId = String(payload.merchantId || '').trim()
  if (merchantId) {
    if (!MERCHANT_ID_RE.test(merchantId)) {
      return fail('MERCHANT_ID_INVALID', '商家 ID 只能包含字母、数字、下划线和短横线')
    }
    if (await getDoc(COL.MERCHANTS, merchantId)) return fail('MERCHANT_EXISTS', '商家 ID 已存在')
  } else {
    merchantId = 'merchant_' + Math.random().toString(36).slice(2, 8)
  }

  const now = new Date()
  const initialPassword = security.newInitialPassword(10)
  const doc = {
    merchantId,
    name,
    status: payload.status === 'disabled' ? 'disabled' : 'active',
    contact: String(payload.contact || '').trim().slice(0, 100),
    plan: String(payload.plan || 'basic').slice(0, 20),
    expiresAt: payload.expiresAt || null,
    flags: { disableOrdering: false, pickupOnly: false, maxConcurrentOrders: 0 },
    loginUsername: merchantId,
    passwordHash: security.hashPassword(initialPassword),
    createdAt: now,
    updatedAt: now,
    settingsRef: paymentDocId(merchantId)
  }
  await db.collection(COL.MERCHANTS).doc(merchantId).set({ data: doc })

  // 初始支付配置（默认转账），避免商家后台首次打开读不到配置
  await db.collection(COL.SETTINGS).doc(paymentDocId(merchantId)).set({
    data: {
      merchantId,
      payMode: 'transfer',
      transfer: { qrImageUrl: '', payeeName: '', tipText: '请先向商家转账，转账后点「我已转账」，商家确认后开始备餐' },
      createdAt: now,
      updatedAt: now,
      updatedBy: 'admin'
    }
  }).catch(() => {})

  return {
    merchantId,
    name,
    status: doc.status,
    loginUsername: doc.loginUsername,
    // 一次性初始密码：只在创建时返回，页面需提示管理员线下交付，之后重置才会再生成
    initialPassword
  }
}

async function merchantUpdate(payload) {
  const merchantId = String(payload.merchantId || '').trim()
  if (!MERCHANT_ID_RE.test(merchantId)) return fail('MERCHANT_ID_INVALID', '商家 ID 不合法')
  const merchant = await getDoc(COL.MERCHANTS, merchantId)
  if (!merchant) return fail('MERCHANT_NOT_FOUND', '商家不存在')

  const patch = { updatedAt: new Date() }
  if (payload.name !== undefined) {
    const name = String(payload.name || '').trim()
    if (!name || name.length > 20) return fail('MERCHANT_NAME_INVALID', '商家名称需为 1-20 个字符')
    patch.name = name
  }
  if (payload.contact !== undefined) patch.contact = String(payload.contact || '').trim().slice(0, 100)
  if (payload.plan !== undefined) patch.plan = String(payload.plan || 'basic').slice(0, 20)
  if (payload.expiresAt !== undefined) patch.expiresAt = payload.expiresAt || null
  if (payload.status !== undefined) {
    if (payload.status !== 'active' && payload.status !== 'disabled') {
      return fail('MERCHANT_STATUS_INVALID', '状态只能是 active / disabled')
    }
    patch.status = payload.status
  }
  await db.collection(COL.MERCHANTS).doc(merchantId).update({ data: patch })
  return { merchantId, updated: true }
}

async function merchantSetStatus(payload) {
  const status = String(payload.status || '')
  if (status !== 'active' && status !== 'disabled') {
    return fail('MERCHANT_STATUS_INVALID', '状态只能是 active / disabled')
  }
  return merchantUpdate({ merchantId: payload.merchantId, status })
}

async function merchantSetFlags(payload) {
  const merchantId = String(payload.merchantId || '').trim()
  if (!MERCHANT_ID_RE.test(merchantId)) return fail('MERCHANT_ID_INVALID', '商家 ID 不合法')
  const merchant = await getDoc(COL.MERCHANTS, merchantId)
  if (!merchant) return fail('MERCHANT_NOT_FOUND', '商家不存在')
  const raw = payload.flags || {}
  const max = Number(raw.maxConcurrentOrders)
  if (raw.maxConcurrentOrders !== undefined && (!Number.isInteger(max) || max < 0 || max > 500)) {
    return fail('FLAGS_INVALID', '并发上限需为 0-500 的整数（0 表示不限）')
  }
  const flags = {
    disableOrdering: raw.disableOrdering === true,
    pickupOnly: raw.pickupOnly === true,
    maxConcurrentOrders: Number.isInteger(max) ? max : 0
  }
  await db.collection(COL.MERCHANTS).doc(merchantId).update({ data: { flags, updatedAt: new Date() } })
  return { merchantId, flags }
}

async function merchantResetPassword(payload) {
  const merchantId = String(payload.merchantId || '').trim()
  if (!MERCHANT_ID_RE.test(merchantId)) return fail('MERCHANT_ID_INVALID', '商家 ID 不合法')
  const merchant = await getDoc(COL.MERCHANTS, merchantId)
  if (!merchant) return fail('MERCHANT_NOT_FOUND', '商家不存在')
  const initialPassword = security.newInitialPassword(10)
  await db.collection(COL.MERCHANTS).doc(merchantId).update({
    data: {
      loginUsername: merchant.loginUsername || merchantId,
      passwordHash: security.hashPassword(initialPassword),
      updatedAt: new Date()
    }
  })
  return { merchantId, loginUsername: merchant.loginUsername || merchantId, initialPassword }
}

/* ------------------------------ 员工绑定 ------------------------------ */

async function staffList(payload) {
  const merchantId = String(payload.merchantId || '').trim()
  if (!MERCHANT_ID_RE.test(merchantId)) return fail('MERCHANT_ID_INVALID', '商家 ID 不合法')
  const list = await fetchAll(COL.STAFF, { merchantId })
  return {
    merchantId,
    list: list.map((staff) => ({
      openid: staff._id,
      merchantId: staff.merchantId,
      role: staff.role === 'owner' ? 'owner' : 'staff',
      name: staff.name || '',
      createdAt: staff.createdAt || null
    }))
  }
}

async function staffBind(payload) {
  const merchantId = String(payload.merchantId || '').trim()
  if (!MERCHANT_ID_RE.test(merchantId)) return fail('MERCHANT_ID_INVALID', '商家 ID 不合法')
  const merchant = await getDoc(COL.MERCHANTS, merchantId)
  if (!merchant) return fail('MERCHANT_NOT_FOUND', '商家不存在')
  const openid = String(payload.openid || '').trim()
  if (!OPENID_RE.test(openid)) return fail('OPENID_INVALID', '请填写有效的小程序 openid')
  const role = payload.role === 'owner' ? 'owner' : 'staff'
  const existing = await getDoc(COL.STAFF, openid)
  // 本期一个 openid 只允许绑定一个商家，避免平台管理员误操作导致串租户
  if (existing && existing.merchantId && existing.merchantId !== merchantId) {
    return fail('STAFF_OTHER_MERCHANT', '该 openid 已绑定其他商家，请先解绑')
  }
  const merchantIds = Array.isArray(existing && existing.merchantIds) ? existing.merchantIds.slice() : []
  if (merchantIds.indexOf(merchantId) < 0) merchantIds.push(merchantId)
  await db.collection(COL.STAFF).doc(openid).set({
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

async function staffUnbind(payload) {
  const openid = String(payload.openid || '').trim()
  if (!OPENID_RE.test(openid)) return fail('OPENID_INVALID', 'openid 不合法')
  const existing = await getDoc(COL.STAFF, openid)
  if (!existing) return fail('STAFF_NOT_FOUND', '该 openid 未绑定任何商家')
  const merchantId = String(payload.merchantId || '').trim()
  if (merchantId && existing.merchantId !== merchantId) {
    return fail('STAFF_MERCHANT_MISMATCH', '该 openid 不属于指定商家')
  }
  await db.collection(COL.STAFF).doc(openid).remove()
  return { openid, removed: true }
}

/* ------------------------------ 健康与日志（只给计数） ------------------------------ */

async function health(payload) {
  const merchantId = String(payload.merchantId || DEFAULT_MERCHANT_ID)
  if (!MERCHANT_ID_RE.test(merchantId)) return fail('MERCHANT_ID_INVALID', '商家 ID 不合法')
  const date = shanghaiDateKey()

  const collections = []
  const missing = []
  for (const name of Object.keys(COLLECTION_LABELS)) {
    const res = await countCollection(name)
    collections.push({ name, label: COLLECTION_LABELS[name], exists: res.exists, total: res.total })
    if (!res.exists) missing.push(name)
  }

  const merchant = await getDoc(COL.MERCHANTS, merchantId)
  const staffCount = await countWhere(COL.STAFF, { merchantId })

  // 平台只读取「是否发布/版本/更新时间」三个状态字段，不读取菜单标题、菜品列表等内容
  let menu = null
  try {
    const menuRes = await db
      .collection(COL.MENUS)
      .where({ _id: menuIdOf(date, merchantId) })
      .field({ published: true, menuVersion: true, updatedAt: true })
      .limit(1)
      .get()
    menu = (menuRes && menuRes.data && menuRes.data[0]) || null
  } catch (err) {
    menu = null
  }
  // 平台只关心支付模式，不读取收款账号/转账说明等商家配置内容
  const payMode = await getPayMode(merchantId)

  // 最近 24 小时错误：只聚合错误码次数，不读取错误参数里的业务值
  const since = new Date(Date.now() - 24 * 3600 * 1000)
  const recent = await fetchAll(COL.ERROR_LOGS, { at: _.gt(since) })
  const byCode = {}
  for (const item of recent) {
    const code = String(item.code || 'UNKNOWN')
    byCode[code] = (byCode[code] || 0) + 1
  }

  // 今日菜单活跃租户数（仅计数）
  const todayMenuCount = await countWhere(COL.MENUS, { date, published: true })

  return {
    ok: missing.length === 0 && !!merchant && merchant.status !== 'disabled',
    serverTime: new Date().toISOString(),
    date,
    defaultMerchantId: DEFAULT_MERCHANT_ID,
    functions: ['api', 'adminAuth', 'adminApi', 'merchantAuth', 'init'],
    merchant: {
      merchantId,
      name: (merchant && merchant.name) || '',
      status: (merchant && merchant.status) || 'missing',
      plan: (merchant && merchant.plan) || '',
      flags: (merchant && merchant.flags) || {},
      staffCount
    },
    collections,
    missingCollections: missing,
    todayMenu: {
      published: !!(menu && menu.published !== false),
      menuVersion: (menu && menu.menuVersion) || null,
      updatedAt: (menu && menu.updatedAt) || null
    },
    todayMenuTenantCount: todayMenuCount,
    payment: { payMode },
    errors: { last24h: recent.length, byCode }
  }
}

async function auditList(payload) {
  const limit = Math.min(Math.max(Number(payload.limit) || 50, 1), 200)
  const res = await db.collection(COL.AUDIT_LOGS).orderBy('at', 'desc').limit(limit).get()
  return {
    list: (res.data || []).map((item) => ({
      actorType: item.actorType || '',
      actorId: item.actorId || '',
      actorName: item.actorName || '',
      action: item.action || '',
      merchantId: item.merchantId || '',
      result: item.result || '',
      code: item.code || '',
      source: item.source || '',
      at: item.at || null
    }))
  }
}

async function errorSummary(payload) {
  const hours = Math.min(Math.max(Number(payload.hours) || 24, 1), 168)
  const since = new Date(Date.now() - hours * 3600 * 1000)
  const list = await fetchAll(COL.ERROR_LOGS, { at: _.gt(since) })
  const byCode = {}
  const byAction = {}
  for (const item of list) {
    const code = String(item.code || 'UNKNOWN')
    const action = String(item.action || '')
    byCode[code] = (byCode[code] || 0) + 1
    byAction[action] = (byAction[action] || 0) + 1
  }
  return { hours, total: list.length, byCode, byAction }
}

/* ------------------------------ 修复工具（盲操作） ------------------------------ */

async function rebuildIndexes() {
  const missing = []
  const totals = {}
  for (const name of Object.keys(COLLECTION_LABELS)) {
    const res = await countCollection(name)
    if (!res.exists) missing.push(name)
    else totals[name] = res.total
  }
  return {
    checked: Object.keys(COLLECTION_LABELS).length,
    missing,
    totals,
    note: '云开发 SDK 无法直接建索引；缺失集合请部署 init 的 setup，索引请在云开发控制台按 _id/merchantId 建单字段索引'
  }
}

async function seedDefaults() {
  const now = new Date()
  const merchant = await getDoc(COL.MERCHANTS, DEFAULT_MERCHANT_ID)
  let created = false
  if (!merchant) {
    await db.collection(COL.MERCHANTS).doc(DEFAULT_MERCHANT_ID).set({
      data: {
        merchantId: DEFAULT_MERCHANT_ID,
        name: '默认商家',
        status: 'active',
        contact: '',
        plan: 'basic',
        expiresAt: null,
        flags: { disableOrdering: false, pickupOnly: false, maxConcurrentOrders: 0 },
        loginUsername: DEFAULT_MERCHANT_ID,
        createdAt: now,
        updatedAt: now,
        settingsRef: 'payment'
      }
    })
    created = true
  }
  const settingsCount = await countWhere(COL.SETTINGS, { _id: paymentDocId(DEFAULT_MERCHANT_ID) })
  let settingsCreated = false
  if (!settingsCount) {
    await db.collection(COL.SETTINGS).doc('payment').set({
      data: {
        merchantId: DEFAULT_MERCHANT_ID,
        payMode: 'transfer',
        transfer: { qrImageUrl: '', payeeName: '', tipText: '请先向商家转账，转账后点「我已转账」，商家确认后开始备餐' },
        createdAt: now,
        updatedAt: now,
        updatedBy: 'admin'
      }
    })
    settingsCreated = true
  }
  return { merchantCreated: created, settingsCreated, merchantId: DEFAULT_MERCHANT_ID }
}

async function cleanOrphans() {
  const merchants = await fetchAll(COL.MERCHANTS)
  const validIds = {}
  for (const item of merchants) validIds[item._id] = true
  const staff = await fetchAll(COL.STAFF)
  let removed = 0
  for (const item of staff) {
    if (validIds[item.merchantId]) continue
    await db.collection(COL.STAFF).doc(item._id).remove().catch(() => {})
    removed += 1
  }
  return { checked: staff.length, removed, note: '仅清理指向不存在商家的员工绑定' }
}

async function resetStaff(payload) {
  const merchantId = String(payload.merchantId || '').trim()
  if (!MERCHANT_ID_RE.test(merchantId)) return fail('MERCHANT_ID_INVALID', '商家 ID 不合法')
  const staff = await fetchAll(COL.STAFF, { merchantId })
  let removed = 0
  for (const item of staff) {
    await db.collection(COL.STAFF).doc(item._id).remove().catch(() => {})
    removed += 1
  }
  return { merchantId, removed }
}

async function revokeTokens(payload) {
  const merchantId = String(payload.merchantId || '').trim()
  if (!MERCHANT_ID_RE.test(merchantId)) return fail('MERCHANT_ID_INVALID', '商家 ID 不合法')
  const merchant = await getDoc(COL.MERCHANTS, merchantId)
  if (!merchant) return fail('MERCHANT_NOT_FOUND', '商家不存在')
  const at = new Date()
  await db.collection(COL.MERCHANTS).doc(merchantId).update({ data: { tokenRevokedAt: at } })
  return { merchantId, revoked: true, at }
}

async function refreshMenuCache(payload) {
  const merchantId = String(payload.merchantId || '').trim()
  if (!MERCHANT_ID_RE.test(merchantId)) return fail('MERCHANT_ID_INVALID', '商家 ID 不合法')
  const date = String(payload.date || shanghaiDateKey())
  const menuId = menuIdOf(date, merchantId)
  const res = await db
    .collection(COL.MENUS)
    .doc(menuId)
    .update({ data: { menuVersion: Date.now(), updatedAt: new Date() } })
    .catch(() => null)
  return {
    merchantId,
    date,
    refreshed: !!(res && res.stats && res.stats.updated),
    note: '只更新时间戳，顾客端下拉刷新即可重新拉取'
  }
}

async function resendPaymentCallback(payload) {
  const orderId = String(payload.orderId || '').trim()
  if (!orderId) return fail('ORDER_ID_REQUIRED', '缺少订单号')
  // 盲操作：不读取订单内容、不返回任何业务字段；支付回调由 pay 云函数按订单号幂等重试
  return { orderId, ok: true, message: '已请求重发支付回调（占位实现，按订单号幂等）' }
}

async function adminChangePassword(event, admin) {
  const payload = event.payload || {}
  const doc = await getDoc(COL.ADMINS, admin.adminId)
  if (!doc) return fail('ADMIN_NOT_FOUND', '管理员不存在')
  if (!security.verifyPassword(payload.currentPassword, doc.passwordHash)) {
    return fail('PASSWORD_MISMATCH', '当前密码不正确')
  }
  const next = String(payload.newPassword || '')
  if (next.length < 8) return fail('PASSWORD_WEAK', '新密码至少 8 位')
  await db.collection(COL.ADMINS).doc(admin.adminId).update({
    data: { passwordHash: security.hashPassword(next), updatedAt: new Date() }
  })
  return { changed: true }
}

const ACTIONS = {
  'merchant.list': merchantList,
  'merchant.create': merchantCreate,
  'merchant.update': merchantUpdate,
  'merchant.setStatus': merchantSetStatus,
  'merchant.setFlags': merchantSetFlags,
  'merchant.resetPassword': merchantResetPassword,
  'staff.list': staffList,
  'staff.bind': staffBind,
  'staff.unbind': staffUnbind,
  health,
  'audit.list': auditList,
  'error.summary': errorSummary,
  'repair.rebuildIndexes': rebuildIndexes,
  'repair.seedDefaults': seedDefaults,
  'repair.cleanOrphans': cleanOrphans,
  'repair.resetStaff': resetStaff,
  'repair.revokeTokens': revokeTokens,
  'repair.refreshMenuCache': refreshMenuCache,
  'repair.resendPaymentCallback': resendPaymentCallback
}

// 启动期自检：action 名必须都在平台白名单里（防止误加业务读接口）
const invalidActions = Object.keys(ACTIONS).filter((name) => !policy.isPlatformAction(name))
if (invalidActions.length) {
  console.error('[adminApi] 发现不在平台白名单中的 action：', invalidActions.join(', '))
}

exports.__actionNames = Object.keys(ACTIONS)

exports.main = async (event) => {
  let admin = null
  try {
    admin = authorize(event)
  } catch (err) {
    return {
      code: err.code || 'UNAUTHORIZED',
      message: err.message || '请先登录管理员账号',
      hint: err.hint || (err.code === 'TOKEN_SECRET_MISSING'
        ? '云开发控制台 → 云函数 → adminApi → 环境变量新增 ADMIN_TOKEN_SECRET（≥16 位，与 adminAuth 一致），保存后重新部署。'
        : '')
    }
  }

  const action = String((event && event.action) || '')
  const payload = (event && event.payload) || {}
  try {
    if (action === 'admin.changePassword') {
      const data = await adminChangePassword(event, admin)
      await writeAudit(admin, action, payload, data)
      return data && data.code !== undefined && data.code !== 0 ? data : ok(data)
    }
    if (policy.isForbiddenBusinessAction(action)) {
      return fail('FORBIDDEN_BUSINESS_ACCESS', '平台管理员不允许读取商家业务明细')
    }
    const handler = ACTIONS[action]
    if (!handler) return fail('UNKNOWN_ACTION', '未知的管理接口：' + action)
    const data = await handler(payload)
    const failed = !!(data && data.code !== undefined && data.message !== undefined && data.code !== 0)
    if (AUDITED_ACTIONS.indexOf(action) >= 0) {
      await writeAudit(admin, action, payload, failed ? { ok: false, code: data.code } : { ok: true })
    }
    return failed ? data : ok(data)
  } catch (err) {
    console.error('[adminApi] 执行失败', action, err)
    if (AUDITED_ACTIONS.indexOf(action) >= 0) {
      await writeAudit(admin, action, payload, { ok: false, code: 'INTERNAL_ERROR' })
    }
    return fail('INTERNAL_ERROR', (err && err.message) || '管理接口执行失败')
  }
}

async function writeAudit(admin, action, payload, result) {
  try {
    await db.collection(COL.AUDIT_LOGS).add({ data: audit.buildAuditRecord(admin, action, payload, result) })
  } catch (err) {
    console.warn('[adminApi] 写审计日志失败', err && err.message)
  }
}
