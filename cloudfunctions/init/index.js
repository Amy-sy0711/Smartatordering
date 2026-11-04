'use strict'

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

/** 与 cloudfunctions/api/core/collections.js 保持一致 */
const COLLECTIONS = [
  'dishes',
  'menus',
  'orders',
  'slot_counters',
  'counters',
  'merchant_admins',
  'settings',
  'payment_records'
]

const MERCHANT_ID = 'merchant_001'
const ADMIN_DOC_ID = 'merchant_admins'

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

/** 初始化集合 + 默认支付配置 + 示例菜品（幂等，可重复执行） */
async function setup(openid) {
  const collections = []
  for (const name of COLLECTIONS) {
    collections.push(await ensureCollection(name))
  }

  const now = new Date()

  if (!(await getDocOrNull('settings', 'payment'))) {
    await db.collection('settings').doc('payment').set({
      data: {
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
  }

  let dishCount = 0
  try {
    const res = await db.collection('dishes').count()
    dishCount = res.total
  } catch (err) {
    dishCount = 0
  }
  if (dishCount === 0) {
    for (const dish of SEED_DISHES) {
      await db.collection('dishes').add({
        data: Object.assign({}, dish, { merchantId: MERCHANT_ID, createdAt: now, updatedAt: now })
      }).catch(() => {})
    }
  }

  const adminDoc = await getDocOrNull('merchant_admins', ADMIN_DOC_ID)
  let adminAdded = false
  if (!adminDoc && openid) {
    await db.collection('merchant_admins').doc(ADMIN_DOC_ID).set({
      data: { openids: [openid], createdAt: now, updatedAt: now }
    }).catch(() => {})
    adminAdded = true
  }

  return {
    collections,
    dishCount: dishCount === 0 ? SEED_DISHES.length : dishCount,
    seededDishes: dishCount === 0,
    adminAdded,
    openid: openid || '',
    note: '如未自动加入商家白名单，请把 openid 填进 cloudfunctions/api/config.js 的 MERCHANT_OPENIDS 或 merchant_admins 集合'
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
      const adminDoc = await getDocOrNull('merchant_admins', ADMIN_DOC_ID)
      const openids = (adminDoc && adminDoc.openids) || []
      return {
        code: 0,
        data: {
          openid,
          isMerchant: openids.indexOf(openid) >= 0,
          admins: openids,
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
