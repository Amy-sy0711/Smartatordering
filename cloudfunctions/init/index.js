'use strict'

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

/** 与 cloudfunctions/api/core/collections.js 保持一致 */
const COLLECTIONS = [
  'merchants',
  'merchant_staff',
  'admins',
  'categories',
  'dishes',
  'menus',
  'orders',
  'slot_counters',
  'counters',
  'merchant_admins',
  'audit_logs',
  'error_logs',
  'settings',
  'payment_records'
]

const MERCHANT_ID = 'merchant_001'
const ADMIN_DOC_ID = 'merchant_admins'
const DEFAULT_CATEGORIES = [
  { name: '盖饭', sort: 1 },
  { name: '面食', sort: 2 },
  { name: '饮品', sort: 3 }
]

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
          { id: 'o1', label: '不辣', priceDeltaCents: 0 },
          { id: 'o2', label: '微辣', priceDeltaCents: 0 },
          { id: 'o3', label: '中辣', priceDeltaCents: 0 }
        ]
      },
      {
        id: 'g2',
        name: '加料',
        required: false,
        options: [
          { id: 'o4', label: '加卤蛋', priceDeltaCents: 200 },
          { id: 'o5', label: '加青菜', priceDeltaCents: 300 }
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
    _id: 'dish_noodle',
    name: '牛肉面',
    category: '面食',
    priceCents: 2000,
    imageUrl: '',
    sortOrder: 3,
    onSale: true,
    soldOut: false,
    specs: [
      {
        id: 'g1',
        name: '面量',
        required: true,
        options: [
          { id: 'o1', label: '正常', priceDeltaCents: 0 },
          { id: 'o2', label: '加面', priceDeltaCents: 300 }
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
    sortOrder: 4,
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
    sortOrder: 5,
    onSale: true,
    soldOut: false,
    specs: []
  }
]

async function ensureCollection(name) {
  try {
    await db.createCollection(name)
    return { name, created: true }
  } catch (err) {
    return { name, created: false }
  }
}

async function getDocOrNull(collection, id) {
  try {
    const res = await db.collection(collection).doc(id).get()
    return (res && res.data) || null
  } catch (err) {
    return null
  }
}

async function fetchAll(collection, where) {
  try {
    const query = where ? db.collection(collection).where(where) : db.collection(collection)
    const res = await query.limit(1000).get()
    return (res && res.data) || []
  } catch (err) {
    return []
  }
}

/** 给旧数据补 merchantId，保证迁移后仍归默认商家 */
async function migrateMerchantId(collection, extraFields) {
  const docs = await fetchAll(collection, { merchantId: db.command.exists(false) })
  let migrated = 0
  for (const doc of docs) {
    const patch = Object.assign({ merchantId: MERCHANT_ID }, extraFields || {})
    await db.collection(collection).doc(doc._id).update({ data: patch }).catch(() => {})
    migrated += 1
  }
  return migrated
}

/** 初始化集合 + 默认商家 + 分类 + 支付配置 + 示例菜品（幂等，可重复执行） */
async function setup(openid) {
  const collections = []
  for (const name of COLLECTIONS) {
    collections.push(await ensureCollection(name))
  }

  const now = new Date()

  // 1) 默认商家
  const merchant = await getDocOrNull('merchants', MERCHANT_ID)
  if (!merchant) {
    await db.collection('merchants').doc(MERCHANT_ID).set({
      data: {
        merchantId: MERCHANT_ID,
        name: '默认商家',
        status: 'active',
        contact: '',
        plan: 'basic',
        expiresAt: null,
        flags: { disableOrdering: false, pickupOnly: false, maxConcurrentOrders: 0 },
        loginUsername: MERCHANT_ID,
        createdAt: now,
        updatedAt: now,
        settingsRef: 'payment'
      }
    }).catch(() => {})
  }

  // 2) 支付配置（默认商家沿用 payment 文档）
  const paymentDoc = await getDocOrNull('settings', 'payment')
  if (!paymentDoc) {
    await db.collection('settings').doc('payment').set({
      data: {
        merchantId: MERCHANT_ID,
        payMode: 'transfer',
        transfer: {
          qrImageUrl: '',
          payeeName: '',
          tipText: '请先向商家转账，转账后点「我已转账」，商家确认后开始备餐'
        },
        updatedAt: now,
        updatedBy: openid || ''
      }
    }).catch(() => {})
  } else if (!paymentDoc.merchantId) {
    await db.collection('settings').doc('payment').update({ data: { merchantId: MERCHANT_ID } }).catch(() => {})
  }

  // 3) 旧数据迁移：菜品 / 菜单 / 订单 / 收款记录 / 计数器
  const migrated = {
    dishes: await migrateMerchantId('dishes'),
    menus: await migrateMerchantId('menus'),
    orders: await migrateMerchantId('orders'),
    paymentRecords: await migrateMerchantId('payment_records'),
    counters: await migrateMerchantId('counters')
  }

  // 4) 分类种子
  const categoryDocs = await fetchAll('categories', { merchantId: MERCHANT_ID })
  let categorySeeded = false
  if (categoryDocs.length === 0) {
    for (const cat of DEFAULT_CATEGORIES) {
      await db.collection('categories').add({
        data: {
          merchantId: MERCHANT_ID,
          name: cat.name,
          sort: cat.sort,
          enabled: true,
          createdAt: now,
          updatedAt: now
        }
      }).catch(() => {})
    }
    categorySeeded = true
  }

  // 5) 菜品种子（只统计本商家）
  const dishes = await fetchAll('dishes', { merchantId: MERCHANT_ID })
  let dishSeeded = false
  if (dishes.length === 0) {
    for (const dish of SEED_DISHES) {
      // 指定 _id 必须用 doc().set()，add() 会忽略/拒绝自定义 _id
      const seeded = Object.assign({}, dish)
      const dishId = seeded._id
      delete seeded._id
      await db.collection('dishes').doc(dishId).set({
        data: Object.assign({}, seeded, { merchantId: MERCHANT_ID, createdAt: now, updatedAt: now })
      }).catch(() => {})
    }
    dishSeeded = true
  }

  // 6) 商家员工绑定：初始化调用者成为默认商家 owner；并迁移旧白名单 openid
  const legacy = await getDocOrNull('merchant_admins', ADMIN_DOC_ID)
  const legacyOpenids = (legacy && Array.isArray(legacy.openids)) ? legacy.openids.map(String) : []
  const staffOpenids = legacyOpenids.slice()
  if (openid && staffOpenids.indexOf(openid) < 0) staffOpenids.push(openid)
  let staffAdded = 0
  for (const staffOpenid of staffOpenids) {
    const existing = await getDocOrNull('merchant_staff', staffOpenid)
    if (existing) continue
    await db.collection('merchant_staff').doc(staffOpenid).set({
      data: {
        openid: staffOpenid,
        merchantId: MERCHANT_ID,
        merchantIds: [MERCHANT_ID],
        role: 'owner',
        name: staffOpenid === openid ? '店主' : '迁移店主',
        createdAt: now
      }
    }).catch(() => {})
    staffAdded += 1
  }

  return {
    collections,
    merchant: { merchantId: MERCHANT_ID, created: !merchant, name: (merchant && merchant.name) || '默认商家' },
    migrated,
    categorySeeded,
    categoryCount: categorySeeded ? DEFAULT_CATEGORIES.length : categoryDocs.length,
    dishSeeded,
    dishCount: dishSeeded ? SEED_DISHES.length : dishes.length,
    staffAdded,
    openid: openid || '',
    note:
      '默认商家与员工绑定已完成。平台管理员请部署 adminAuth 云函数并配置环境变量 ADMIN_TOKEN_SECRET / ADMIN_BOOTSTRAP_PASSWORD，在管理台用初始口令登录一次即创建管理员；口令随后失效。'
  }
}

exports.main = async (event) => {
  const action = String((event && event.action) || 'setup')
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID || ''

  try {
    if (action === 'setup') {
      return { code: 0, data: await setup(openid) }
    }
    if (action === 'whoami') {
      const staff = openid ? await getDocOrNull('merchant_staff', openid) : null
      const merchant = staff ? await getDocOrNull('merchants', staff.merchantId) : null
      return {
        code: 0,
        data: {
          openid,
          role: staff ? (staff.role === 'owner' ? 'owner' : 'staff') : 'customer',
          merchantId: (staff && staff.merchantId) || MERCHANT_ID,
          merchantName: (merchant && merchant.name) || '默认商家',
          merchantStatus: (merchant && merchant.status) || 'active',
          appid: wxContext.APPID || ''
        }
      }
    }
    return { code: 'UNKNOWN_ACTION', message: '未知的初始化接口：' + action }
  } catch (err) {
    console.error('[init] 初始化失败', err)
    return { code: 'INTERNAL_ERROR', message: (err && err.message) || '初始化失败' }
  }
}
