'use strict'

/**
 * 离线单测：只依赖纯逻辑模块（不依赖 wx-server-sdk / 云环境）。
 * 运行：node tests/run-tests.js
 */

const assert = require('assert')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const CORE = path.join(ROOT, 'cloudfunctions', 'api', 'core')
const MINI_UTILS = path.join(ROOT, 'miniprogram', 'utils')

const money = require(path.join(CORE, 'money'))
const dates = require(path.join(CORE, 'dates'))
const pricing = require(path.join(CORE, 'pricing'))
const slots = require(path.join(CORE, 'slots'))
const state = require(path.join(CORE, 'state'))
const packing = require(path.join(CORE, 'packing'))
const stats = require(path.join(CORE, 'stats'))
const paymode = require(path.join(CORE, 'paymode'))
const localBackend = require(path.join(MINI_UTILS, 'local-backend'))
const roleRouter = require(path.join(MINI_UTILS, 'role-router'))
const safe = require(path.join(MINI_UTILS, 'safe'))
const merchantGuard = require(path.join(MINI_UTILS, 'merchant-guard'))
const menuCache = require(path.join(MINI_UTILS, 'menu-cache'))
const dataSource = require(path.join(MINI_UTILS, 'data-source'))
const tenant = require(path.join(CORE, 'tenant'))
const actionPolicy = require(path.join(CORE, 'action-policy'))
const identityCore = require(path.join(CORE, 'identity'))
const categoriesCore = require(path.join(CORE, 'categories'))
const exportCore = require(path.join(CORE, 'export'))
const merchantToken = require(path.join(CORE, 'merchant-token'))
const adminPolicy = require(path.join(ROOT, 'cloudfunctions', 'adminApi', 'core', 'policy'))
const adminAudit = require(path.join(ROOT, 'cloudfunctions', 'adminApi', 'core', 'audit'))
const adminAuthCore = require(path.join(ROOT, 'cloudfunctions', 'adminAuth', 'core', 'auth-core'))
const loginStateFactory = require(path.join(ROOT, 'admin-console', 'login-state'))
const adminDiagnostics = require(path.join(ROOT, 'admin-console', 'diagnostics'))
const platformGuard = require(path.join(MINI_UTILS, 'platform-guard'))
const httpAdapter = require(path.join(ROOT, 'cloudfunctions', 'adminApi', 'core', 'http-adapter'))
const gatewayCore = require(path.join(ROOT, 'tools', 'admin-gateway', 'core'))

let passed = 0
let failed = 0
const failures = []

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  PASS  ' + name)
  } catch (err) {
    failed += 1
    failures.push({ name, err })
    console.log('  FAIL  ' + name)
    console.log('        ' + (err && err.message))
  }
}

/** 异步用例：按声明顺序串行执行，全部结束后再汇总 */
const asyncTests = []
function testAsync(name, fn) {
  asyncTests.push({ name, fn })
}

async function flushAsyncTests() {
  for (const item of asyncTests) {
    try {
      await item.fn()
      passed += 1
      console.log('  PASS  ' + item.name)
    } catch (err) {
      failed += 1
      failures.push({ name: item.name, err })
      console.log('  FAIL  ' + item.name)
      console.log('        ' + (err && err.message))
    }
  }
}

function expectCode(fn, code) {
  let thrown = null
  try {
    fn()
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown, '期望抛出 ' + code + '，但实际没有抛错')
  assert.strictEqual(thrown.code, code, '期望错误码 ' + code + '，实际 ' + thrown.code + '（' + thrown.message + '）')
}

/* ------------------------------ 金额 ------------------------------ */
console.log('\n[金额：整数分]')

test('formatCents 整数分格式化', () => {
  assert.strictEqual(money.formatCents(0), '0.00')
  assert.strictEqual(money.formatCents(5), '0.05')
  assert.strictEqual(money.formatCents(1250), '12.50')
  assert.strictEqual(money.formatCents(123456), '1234.56')
})

test('parseYuanToCents 字符串解析（不经过浮点）', () => {
  assert.strictEqual(money.parseYuanToCents('12.5'), 1250)
  assert.strictEqual(money.parseYuanToCents('12.05'), 1205)
  assert.strictEqual(money.parseYuanToCents('12'), 1200)
  assert.strictEqual(money.parseYuanToCents('0.1'), 10)
  assert.strictEqual(money.parseYuanToCents('abc'), null)
  assert.strictEqual(money.parseYuanToCents('1.234'), null)
})

test('assertCents 拒绝小数/字符串金额', () => {
  expectCode(() => money.assertCents(12.5, '价格'), 'MONEY_NOT_INTEGER')
  expectCode(() => money.assertCents('1250', '价格'), 'MONEY_NOT_INTEGER')
})

test('multiply 与 sum 保持整数分', () => {
  assert.strictEqual(money.multiply(2200, 3), 6600)
  assert.strictEqual(money.sum([100, 200, 300]), 600)
  expectCode(() => money.multiply(2200, 1.5), 'QTY_INVALID')
})

/* ------------------------------ 定价重算 ------------------------------ */
console.log('\n[下单价格服务端重算]')

const DISHES = [
  {
    _id: 'd1',
    name: '黄焖鸡',
    priceCents: 2200,
    onSale: true,
    soldOut: false,
    specs: [
      {
        id: 'g1',
        name: '辣度',
        required: true,
        options: [
          { id: 'o1', label: '不辣', priceDeltaCents: 0 },
          { id: 'o2', label: '中辣', priceDeltaCents: 0 }
        ]
      },
      {
        id: 'g2',
        name: '加料',
        required: false,
        options: [{ id: 'o3', label: '加蛋', priceDeltaCents: 200 }]
      }
    ]
  },
  { _id: 'd2', name: '酸梅汤', priceCents: 500, onSale: true, soldOut: false, specs: [] },
  { _id: 'd3', name: '售罄菜', priceCents: 1000, onSale: true, soldOut: true, specs: [] },
  { _id: 'd4', name: '下架菜', priceCents: 1000, onSale: false, soldOut: false, specs: [] }
]

function priceWith(cartItems, extra) {
  return pricing.recalculateOrder(
    Object.assign(
      {
        dishes: DISHES,
        cartItems,
        menuDishIds: ['d1', 'd2', 'd3', 'd4'],
        maxQtyPerItem: 20,
        maxLines: 30
      },
      extra || {}
    )
  )
}

test('价格只取服务端菜品价 + 规格加价（忽略前端金额）', () => {
  const result = priceWith([
    { dishId: 'd1', qty: 2, specOptionIds: ['o1', 'o3'], priceCents: 1, totalCents: 1, lineTotalCents: 1 },
    { dishId: 'd2', qty: 1, specOptionIds: [], priceCents: 1 }
  ])
  assert.strictEqual(result.totalCents, (2200 + 200) * 2 + 500)
  assert.strictEqual(result.totalQty, 3)
  assert.strictEqual(result.items.length, 2)
  assert.strictEqual(result.items[0].specText, '不辣 / 加蛋')
  assert.strictEqual(result.items[0].lineTotalCents, 4800)
})

test('同菜同规格合并后再做数量上限校验', () => {
  const result = priceWith([
    { dishId: 'd2', qty: 1, specOptionIds: [] },
    { dishId: 'd2', qty: 1, specOptionIds: [] }
  ])
  assert.strictEqual(result.items.length, 1)
  assert.strictEqual(result.items[0].qty, 2)
  assert.strictEqual(result.totalCents, 1000)
})

test('售罄菜品拒绝下单', () => {
  expectCode(() => priceWith([{ dishId: 'd3', qty: 1, specOptionIds: [] }]), 'DISH_SOLD_OUT')
})

test('下架菜品拒绝下单', () => {
  expectCode(() => priceWith([{ dishId: 'd4', qty: 1, specOptionIds: [] }]), 'DISH_OFF_SALE')
})

test('不在今日菜单的菜品拒绝下单', () => {
  expectCode(() => priceWith([{ dishId: 'd2', qty: 1, specOptionIds: [] }], { menuDishIds: ['d1'] }), 'DISH_NOT_IN_MENU')
})

test('菜品不存在拒绝下单', () => {
  expectCode(() => priceWith([{ dishId: 'dx', qty: 1, specOptionIds: [] }]), 'DISH_NOT_FOUND')
})

test('必选规格未选择时拒绝', () => {
  expectCode(() => priceWith([{ dishId: 'd1', qty: 1, specOptionIds: ['o3'] }]), 'SPEC_REQUIRED')
})

test('未知规格选项拒绝', () => {
  expectCode(() => priceWith([{ dishId: 'd1', qty: 1, specOptionIds: ['o1', 'oX'] }]), 'SPEC_INVALID')
})

test('单菜数量超过上限时拒绝', () => {
  expectCode(() => priceWith([{ dishId: 'd2', qty: 21, specOptionIds: [] }]), 'QTY_LIMIT')
})

test('空购物车拒绝', () => {
  expectCode(() => priceWith([]), 'CART_EMPTY')
})

test('菜品价格不是整数分时拒绝重算', () => {
  const bad = [{ _id: 'd1', name: '坏价格', priceCents: 22.5, onSale: true, specs: [] }]
  expectCode(() => pricing.recalculateOrder({ dishes: bad, cartItems: [{ dishId: 'd1', qty: 1, specOptionIds: [] }] }), 'MONEY_NOT_INTEGER')
})

/* ------------------------------ 取餐时段 ------------------------------ */
console.log('\n[取餐时段与限量]')

test('normalizeSlots 生成稳定编号 s1..sN', () => {
  const result = slots.normalizeSlots([{ label: '11:30-12:00', limit: 20 }, { label: '12:00-12:30', limit: '' }], 20)
  assert.strictEqual(result.length, 2)
  assert.strictEqual(result[0].id, 's1')
  assert.strictEqual(result[1].id, 's2')
  assert.strictEqual(result[1].limit, 20)
})

test('时段名重复或为空时拒绝', () => {
  expectCode(() => slots.normalizeSlots([{ label: 'A', limit: 10 }, { label: 'A', limit: 10 }], 20), 'SLOT_INVALID')
  expectCode(() => slots.normalizeSlots([{ label: '  ', limit: 10 }], 20), 'SLOT_INVALID')
})

test('时段限量必须为 1-500 的整数', () => {
  expectCode(() => slots.normalizeSlots([{ label: 'A', limit: 0 }], 20), 'SLOT_LIMIT_INVALID')
  expectCode(() => slots.normalizeSlots([{ label: 'A', limit: 1.5 }], 20), 'SLOT_LIMIT_INVALID')
})

test('checkCapacity 在第 limit 单时抛出 SLOT_FULL', () => {
  assert.strictEqual(slots.checkCapacity(0, 20), 1)
  assert.strictEqual(slots.checkCapacity(19, 20), 20)
  expectCode(() => slots.checkCapacity(20, 20), 'SLOT_FULL')
})

test('slotAvailability 正确计算余量与满档', () => {
  const info = slots.slotAvailability({ id: 's1', label: 'A', limit: 20 }, 20)
  assert.strictEqual(info.left, 0)
  assert.strictEqual(info.full, true)
  const info2 = slots.slotAvailability({ id: 's2', label: 'B', limit: 20 }, 5)
  assert.strictEqual(info2.left, 15)
  assert.strictEqual(info2.full, false)
})

/* ------------------------------ 状态机 ------------------------------ */
console.log('\n[订单状态机]')

test('transfer：pending_pay → pending_confirm → paid', () => {
  assert.strictEqual(state.assertAction('pending_pay', 'transfer'), 'pending_confirm')
  assert.strictEqual(state.assertAction('pending_confirm', 'confirm'), 'paid')
})

test('未确认收款（pending_confirm）不能接单', () => {
  expectCode(() => state.assertAction('pending_confirm', 'accept'), 'ILLEGAL_TRANSITION')
})

test('未付款（pending_pay）不能接单', () => {
  expectCode(() => state.assertAction('pending_pay', 'accept'), 'ILLEGAL_TRANSITION')
})

test('已收款后的合法流转：paid → ready（无接单），accepted 仅兼容', () => {
  assert.strictEqual(state.assertAction('paid', 'accept'), 'accepted') // 历史兼容
  assert.strictEqual(state.assertAction('paid', 'ready'), 'ready')     // 新流程：已收款直接出餐
  assert.strictEqual(state.assertAction('accepted', 'ready'), 'ready') // 历史数据兼容
  assert.strictEqual(state.assertAction('ready', 'complete'), 'completed')
})

test('非法流转被拒绝（accepted 不能直接 completed）', () => {
  expectCode(() => state.assertAction('accepted', 'complete'), 'ILLEGAL_TRANSITION')
  expectCode(() => state.assertTransition('pending_pay', 'accepted'), 'ILLEGAL_TRANSITION')
  expectCode(() => state.assertTransition('completed', 'canceled'), 'ILLEGAL_TRANSITION')
})

test('取消只允许在非终态发生', () => {
  for (const status of ['pending_pay', 'pending_confirm', 'paid', 'accepted', 'ready']) {
    assert.strictEqual(state.assertAction(status, 'cancel'), 'canceled')
  }
  expectCode(() => state.assertAction('completed', 'cancel'), 'ILLEGAL_TRANSITION')
  expectCode(() => state.assertAction('canceled', 'cancel'), 'ILLEGAL_TRANSITION')
})

test('已确认收款订单 hasReceivedMoney 为真', () => {
  assert.strictEqual(state.hasReceivedMoney({ status: 'paid' }), false)
  assert.strictEqual(state.hasReceivedMoney({ status: 'paid', confirmedAt: new Date() }), true)
  assert.strictEqual(state.hasReceivedMoney({ status: 'paid', paidAt: new Date() }), true)
})

/* ------------------------------ 打包聚合 ------------------------------ */
console.log('\n[打包清单聚合]')

const PACKING_ORDERS = [
  {
    _id: 'o1',
    orderNo: '20261104-0001',
    totalCents: 4700,
    packed: false,
    remark: '不要香菜',
    pickupSlot: { id: 's1', label: '11:30-12:00' },
    createdAt: new Date('2026-11-04T03:30:00Z'),
    items: [
      { dishId: 'd1', name: '黄焖鸡', specText: '不辣', qty: 2, lineTotalCents: 4400 },
      { dishId: 'd2', name: '酸梅汤', specText: '', qty: 1, lineTotalCents: 500 }
    ]
  },
  {
    _id: 'o2',
    orderNo: '20261104-0002',
    totalCents: 2700,
    packed: true,
    remark: '',
    pickupSlot: { id: 's2', label: '12:00-12:30' },
    createdAt: new Date('2026-11-04T03:40:00Z'),
    items: [
      { dishId: 'd1', name: '黄焖鸡', specText: '不辣', qty: 1, lineTotalCents: 2200 },
      { dishId: 'd2', name: '酸梅汤', specText: '', qty: 1, lineTotalCents: 500 }
    ]
  }
]

test('按菜品+规格聚合数量与订单数', () => {
  const result = packing.buildPackingList(PACKING_ORDERS, { date: '2026-11-04', dateLabel: '2026-11-04 周三' })
  assert.strictEqual(result.orderCount, 2)
  assert.strictEqual(result.itemCount, 5)
  assert.strictEqual(result.totalCents, 7400)

  const group = result.groups.filter((item) => item.key === 'd1::不辣')[0]
  assert.ok(group, '应存在 d1::不辣 聚合组')
  assert.strictEqual(group.qty, 3)
  assert.strictEqual(result.groups.filter((item) => item.dishId === 'd2')[0].qty, 2)
  assert.strictEqual(result.orders.filter((item) => item.orderNo === '20261104-0001')[0].packed, false)
})

test('生成可复制文本包含汇总与逐单明细', () => {
  const result = packing.buildPackingList(PACKING_ORDERS, { dateLabel: '2026-11-04 周三' })
  assert.ok(result.text.indexOf('打包清单 2026-11-04 周三') >= 0)
  assert.ok(result.text.indexOf('黄焖鸡（不辣） x3') >= 0)
  assert.ok(result.text.indexOf('备注：不要香菜') >= 0)
  assert.ok(result.text.indexOf('[已打包]') >= 0)
})

/* ------------------------------ 当日收益 ------------------------------ */
console.log('\n[当日收益聚合]')

function makeOrder(id, status, totalCents, items, extra) {
  return Object.assign(
    {
      _id: id,
      status,
      totalCents,
      items: items || []
    },
    extra || {}
  )
}

const STATS_ORDERS = [
  makeOrder('s1', 'paid', 2300, [{ dishId: 'd1', name: '黄焖鸡', qty: 1, lineTotalCents: 2300 }]),
  makeOrder('s2', 'completed', 1800, [{ dishId: 'd2', name: '番茄鸡蛋饭', qty: 1, lineTotalCents: 1800 }]),
  makeOrder('s3', 'accepted', 2200, [{ dishId: 'd1', name: '黄焖鸡', qty: 1, lineTotalCents: 2200 }]),
  makeOrder('s4', 'pending_confirm', 1500, [{ dishId: 'd1', name: '黄焖鸡', qty: 1, lineTotalCents: 1500 }]),
  makeOrder('s5', 'pending_pay', 900, []),
  makeOrder('s6', 'canceled', 1000, [], { paidAt: new Date(), refunded: true }),
  makeOrder('s7', 'canceled', 700, [])
]

test('已收款/待确认/待付款/退款口径分离', () => {
  const result = stats.buildDailyStats(STATS_ORDERS, { date: '2026-11-04' })
  assert.strictEqual(result.orderCount, 7)
  assert.strictEqual(result.paidCount, 3)
  assert.strictEqual(result.paidCents, 6300)
  assert.strictEqual(result.paidCentsText, '63.00')
  assert.strictEqual(result.pendingConfirmCount, 1)
  assert.strictEqual(result.pendingConfirmCents, 1500)
  assert.strictEqual(result.pendingPayCount, 1)
  assert.strictEqual(result.pendingPayCents, 900)
  assert.strictEqual(result.canceledCount, 2)
  assert.strictEqual(result.refundCount, 1)
  assert.strictEqual(result.refundCents, 1000)
  assert.strictEqual(result.avgOrderCents, 2100)
})

test('待确认订单在商家确认收款后才计入已收款金额', () => {
  const before = stats.buildDailyStats(STATS_ORDERS, { date: '2026-11-04' })
  assert.strictEqual(before.paidCents, 6300)

  const confirmed = STATS_ORDERS.map((order) => {
    if (order._id !== 's4') return order
    return Object.assign({}, order, { status: 'paid', paidAt: new Date(), confirmedAt: new Date() })
  })
  const after = stats.buildDailyStats(confirmed, { date: '2026-11-04' })
  assert.strictEqual(after.paidCents, 7800)
  assert.strictEqual(after.paidCount, 4)
  assert.strictEqual(after.pendingConfirmCents, 0)
})

test('菜品销量排行只统计已收款订单', () => {
  const result = stats.buildDailyStats(STATS_ORDERS, { date: '2026-11-04' })
  assert.strictEqual(result.dishRank.length, 2)
  assert.strictEqual(result.dishRank[0].dishId, 'd1')
  assert.strictEqual(result.dishRank[0].qty, 2)
  assert.strictEqual(result.dishRank[0].salesCents, 4500)
  assert.strictEqual(result.dishRank[1].dishId, 'd2')
})

test('平均客单价用整数除法，不产生小数分', () => {
  const result = stats.buildDailyStats(
    [makeOrder('a', 'paid', 1000, []), makeOrder('b', 'paid', 1000, []), makeOrder('c', 'paid', 1001, [])],
    { date: '2026-11-04' }
  )
  assert.strictEqual(result.avgOrderCents, 1000)
})

/* ------------------------------ 支付方式配置 ------------------------------ */
console.log('\n[支付方式可配置]')

test('默认 payMode 为 transfer', () => {
  assert.strictEqual(paymode.DEFAULT_PAYMENT_SETTINGS.payMode, 'transfer')
  const normalized = paymode.normalizePaymentSettings(undefined)
  assert.strictEqual(normalized.payMode, 'transfer')
  assert.ok(normalized.transfer.tipText.length > 0)
  assert.strictEqual(normalized.transfer.qrImageUrl, '')
})

test('transfer / mock 始终可用', () => {
  assert.strictEqual(paymode.resolvePayBranch({ payMode: 'transfer' }).usable, true)
  assert.strictEqual(paymode.resolvePayBranch({ payMode: 'mock' }).usable, true)
})

test('jsapi 未配置商户号时返回 WXPAY_NOT_CONFIGURED 且带中文提示', () => {
  const branch = paymode.resolvePayBranch({ payMode: 'jsapi', wxpayEnabled: false, subMchId: '', envId: '' })
  assert.strictEqual(branch.usable, false)
  assert.strictEqual(branch.code, 'WXPAY_NOT_CONFIGURED')
  assert.ok(branch.message && branch.message.indexOf('商户号') >= 0)
})

test('jsapi 配置完整时可用', () => {
  const branch = paymode.resolvePayBranch({
    payMode: 'jsapi',
    wxpayEnabled: true,
    subMchId: '1234567890',
    envId: 'cloud-env-id'
  })
  assert.strictEqual(branch.usable, true)
  assert.strictEqual(branch.code, undefined)
})

test('assertPayBranchUsable 在不可用时抛业务错误（前端可弹窗，不白屏）', () => {
  const branch = paymode.resolvePayBranch({ payMode: 'jsapi', wxpayEnabled: false })
  expectCode(() => paymode.assertPayBranchUsable(branch), 'WXPAY_NOT_CONFIGURED')
})

test('未知 payMode 回落 transfer', () => {
  assert.strictEqual(paymode.normalizePayMode('wechat'), 'transfer')
  const branch = paymode.resolvePayBranch({ payMode: 'wechat' })
  assert.strictEqual(branch.mode, 'transfer')
  assert.strictEqual(branch.usable, true)
})

/* ------------------------------ 时区 ------------------------------ */
console.log('\n[Asia/Shanghai 自然日]')

test('UTC 16:30 已属于上海次日', () => {
  assert.strictEqual(dates.shanghaiDateKey(new Date('2026-11-03T16:30:00Z')), '2026-11-04')
})

test('UTC 15:59 仍属于上海当日', () => {
  assert.strictEqual(dates.shanghaiDateKey(new Date('2026-11-03T15:59:00Z')), '2026-11-03')
})

test('dayRange 与 dateKey 对齐（24 小时）', () => {
  const range = dates.dayRange('2026-11-04')
  assert.strictEqual(range.end - range.start, 24 * 60 * 60 * 1000)
  assert.strictEqual(dates.shanghaiDateKey(new Date(range.start)), '2026-11-04')
  assert.strictEqual(dates.shanghaiDateKey(new Date(range.end - 1)), '2026-11-04')
})

/* ------------------------------ 启动身份分流 ------------------------------ */
console.log('\n[启动身份分流（登录 → whoami → 分流）]')

test('isMerchant === true 进入商家看板', () => {
  const decision = roleRouter.resolveStartRoute({ openid: 'o1', isMerchant: true })
  assert.strictEqual(decision.target, '/pages/merchant/index/index')
  assert.strictEqual(decision.isMerchant, true)
  assert.strictEqual(decision.failed, false)
})

test('isMerchant === false 进入顾客端菜单', () => {
  const decision = roleRouter.resolveStartRoute({ openid: 'o1', isMerchant: false })
  assert.strictEqual(decision.target, '/pages/menu/menu')
  assert.strictEqual(decision.isMerchant, false)
  assert.strictEqual(decision.failed, false)
})

test('身份识别失败进入顾客端并标记失败（不误进商家端）', () => {
  const decision = roleRouter.resolveStartRoute({ error: { code: 'CALL_FAILED', message: '云函数不可达' } })
  assert.strictEqual(decision.target, '/pages/menu/menu')
  assert.strictEqual(decision.isMerchant, false)
  assert.strictEqual(decision.failed, true)
  assert.strictEqual(decision.errorCode, 'CALL_FAILED')
  assert.ok(decision.errorMessage.indexOf('云函数') >= 0)
})

/* ------------------------------ local 数据源 ------------------------------ */
console.log('\n[本地演示模式（local）数据源]')

function memoryStorage() {
  let data = null
  return {
    get() {
      return data
    },
    set(key, value) {
      data = value
    },
    remove() {
      data = null
    },
    dump() {
      return data
    }
  }
}

function makeLocal() {
  const storage = memoryStorage()
  const at = new Date('2026-11-05T03:00:00Z') // 上海时间 11:00
  const backend = localBackend.createLocalBackend({ storage, now() { return at } })
  return { storage, backend, at }
}

function localCreate(backend, cartItems, extra) {
  return backend.run('order.create', Object.assign({ cartItems, slotId: 's1', remark: '' }, extra || {}))
}

test('首次启动自动写入种子：3+ 分类、6-8 菜、1 规格菜、1 售罄菜、1 时段限量 20、transfer', () => {
  const { backend } = makeLocal()
  const menu = backend.run('menu.today')
  assert.strictEqual(menu.published, true)
  assert.ok(menu.categories.length >= 3, '至少 3 个分类')
  assert.ok(menu.totalDishes >= 6 && menu.totalDishes <= 8, '菜品数应在 6-8')
  assert.strictEqual(menu.slots.length, 1)
  assert.strictEqual(menu.slots[0].limit, 20)
  assert.strictEqual(menu.slots[0].left, 20)
  assert.strictEqual(menu.payment.payMode, 'transfer')
  const allDishes = menu.categories.reduce((acc, cat) => acc.concat(cat.dishes), [])
  assert.ok(allDishes.filter((dish) => dish.specs.length > 0).length >= 1, '至少 1 个规格菜')
  assert.ok(allDishes.filter((dish) => dish.soldOut).length >= 1, '至少 1 个售罄菜')
})

test('local whoami 默认非商家，可手动切换商家视图再切回', () => {
  const { backend } = makeLocal()
  assert.strictEqual(backend.run('whoami').isMerchant, false)
  assert.strictEqual(backend.run('merchant.switchRole', { merchant: true }).isMerchant, true)
  assert.strictEqual(backend.run('merchant.checkAccess', { claim: false }).isMerchant, true)
  assert.strictEqual(backend.run('merchant.switchRole', { merchant: false }).isMerchant, false)
})

test('local 下单重算价格：忽略前端金额、计入规格加价', () => {
  const { backend } = makeLocal()
  const created = localCreate(backend, [
    { dishId: 'dish_hdg', qty: 2, specOptionIds: ['g1o1', 'g2o1'], priceCents: 1, lineTotalCents: 1 },
    { dishId: 'dish_drink', qty: 1, specOptionIds: [] }
  ])
  assert.strictEqual(created.totalCents, (2200 + 200) * 2 + 500)
  assert.strictEqual(created.totalQty, 3)
  assert.ok(/^20261105-000\d$/.test(created.orderNo), '订单号应为日期+序号')
  const menu = backend.run('menu.today')
  assert.strictEqual(menu.slots[0].left, 19)
})

test('local 时段限量：名额用满后拒绝下单', () => {
  const { storage, backend } = makeLocal()
  backend.run('menu.today') // 触发首次种子写入
  const db = storage.dump()
  const key = Object.keys(db.slotCounters)[0]
  db.slotCounters[key].used = db.slotCounters[key].limit
  storage.set('local_db_v1', db)
  expectCode(() => localCreate(backend, [{ dishId: 'dish_drink', qty: 1, specOptionIds: [] }]), 'SLOT_FULL')
})

test('local 转账闭环（两次点击）：pending_pay → pending_confirm → paid → ready → completed，无接单', () => {
  const { backend } = makeLocal()
  const created = localCreate(backend, [{ dishId: 'dish_drink', qty: 1, specOptionIds: [] }])
  const orderId = created.orderId
  assert.strictEqual(backend.run('order.markTransferred', { orderId }).status, 'pending_confirm')
  const confirmed = backend.run('merchant.confirmReceipt', { orderId })
  assert.strictEqual(confirmed.order.status, 'paid')
  assert.strictEqual(confirmed.record.amountCents, 500)
  // 确认收款不生成取餐码
  assert.strictEqual(backend.run('order.detail', { orderId }).pickupCode, '')
  // 已收款直接出餐，不再经过 accepted
  const ready = backend.run('merchant.transition', { orderId, action: 'ready' })
  assert.strictEqual(ready.status, 'ready')
  assert.ok(ready.pickupCode, '出餐当场生成取餐码')
  assert.strictEqual(backend.run('merchant.transition', { orderId, action: 'complete' }).status, 'completed')
  assert.strictEqual(backend.run('order.detail', { orderId }).status, 'completed')
})

test('local accepted 仅为历史兼容：可直接出餐到 ready', () => {
  const { storage, backend } = makeLocal()
  const orderId = localCreate(backend, [{ dishId: 'dish_drink', qty: 1, specOptionIds: [] }]).orderId
  backend.run('merchant.confirmReceipt', { orderId })
  // 模拟历史数据停在 accepted（新流程 UI 不会再产生）
  const db = storage.dump()
  db.orders[orderId].status = 'accepted'
  storage.set('local_db_v1', db)
  const ready = backend.run('merchant.transition', { orderId, action: 'ready' })
  assert.strictEqual(ready.status, 'ready')
  assert.ok(ready.pickupCode, '历史 accepted 订单也能出码')
})

test('local 商家可直接对 pending_pay 确认收款，重复确认被拒', () => {
  const { backend } = makeLocal()
  const orderId = localCreate(backend, [{ dishId: 'dish_drink', qty: 1, specOptionIds: [] }]).orderId
  assert.strictEqual(backend.run('order.detail', { orderId }).status, 'pending_pay')
  const confirmed = backend.run('merchant.confirmReceipt', { orderId })
  assert.strictEqual(confirmed.order.status, 'paid')
  assert.strictEqual(confirmed.record.amountCents, 500)
  expectCode(() => backend.run('merchant.confirmReceipt', { orderId }), 'ILLEGAL_TRANSITION')
  // 确认收款后才允许出餐（商家视图下发的 actions）
  const detail = backend.run('order.detail', { orderId, asMerchant: true })
  assert.ok(detail.actions.indexOf('ready') >= 0, '已收款订单应下发 ready 动作')
  assert.ok(detail.actions.indexOf('accept') < 0, '新流程不再下发接单动作')
  assert.strictEqual(backend.run('merchant.transition', { orderId, action: 'ready' }).status, 'ready')
})

test('local 出餐生成取餐码：0001 起自增，取餐后仍展示，重复出餐不重号', () => {
  const { backend } = makeLocal()
  const first = localCreate(backend, [{ dishId: 'dish_drink', qty: 1, specOptionIds: [] }]).orderId
  const second = localCreate(backend, [{ dishId: 'dish_drink', qty: 2, specOptionIds: [] }]).orderId

  assert.strictEqual(backend.run('order.detail', { orderId: first }).pickupCode, '', '未出餐不展示取餐码')
  backend.run('merchant.confirmReceipt', { orderId: first })
  assert.strictEqual(backend.run('order.detail', { orderId: first }).pickupCode, '', '已收款备餐中不展示取餐码')
  const readyFirst = backend.run('merchant.transition', { orderId: first, action: 'ready' })
  assert.strictEqual(readyFirst.pickupCode, '0001')
  assert.strictEqual(backend.run('order.detail', { orderId: first }).pickupCode, '0001')

  backend.run('merchant.confirmReceipt', { orderId: second })
  assert.strictEqual(backend.run('merchant.transition', { orderId: second, action: 'ready' }).pickupCode, '0002')

  // 重复点「出餐」被状态机拒绝，且不改变已生成取餐码
  expectCode(() => backend.run('merchant.transition', { orderId: first, action: 'ready' }), 'ILLEGAL_TRANSITION')
  assert.strictEqual(backend.run('order.detail', { orderId: first }).pickupCode, '0001')

  const done = backend.run('merchant.transition', { orderId: first, action: 'complete' })
  assert.strictEqual(done.pickupCode, '0001', '已取餐后仍保留取餐码')
})

test('local 待取餐文案：顾客端 statusText 使用新语义', () => {
  const { backend } = makeLocal()
  const orderId = localCreate(backend, [{ dishId: 'dish_drink', qty: 1, specOptionIds: [] }]).orderId
  assert.strictEqual(backend.run('order.detail', { orderId }).customerStatusText, '待支付')
  backend.run('order.markTransferred', { orderId })
  assert.strictEqual(backend.run('order.detail', { orderId }).customerStatusText, '待商家确认')
  backend.run('merchant.confirmReceipt', { orderId })
  assert.strictEqual(backend.run('order.detail', { orderId }).customerStatusText, '已支付备餐中')
  backend.run('merchant.transition', { orderId, action: 'ready' })
  assert.strictEqual(backend.run('order.detail', { orderId }).customerStatusText, '待取餐')
  backend.run('merchant.transition', { orderId, action: 'complete' })
  assert.strictEqual(backend.run('order.detail', { orderId }).customerStatusText, '已取餐')
})

test('local 顾客历史订单：跨天可见、按时间倒序、分页不丢单', () => {
  const { storage, backend } = makeLocal()
  const orderId = localCreate(backend, [{ dishId: 'dish_drink', qty: 1, specOptionIds: [] }]).orderId
  const db = storage.dump()
  const base = db.orders[orderId]
  // 造 24 条 10 月的历史订单，验证跨天不再被日期条件藏掉
  for (let i = 1; i <= 24; i++) {
    const day = String(i).padStart(2, '0')
    const id = '202610' + day + '-0001'
    db.orders[id] = Object.assign({}, base, {
      _id: id,
      orderNo: id,
      date: '202610' + day,
      createdAt: '2026-10-' + day + 'T02:00:00.000Z',
      updatedAt: '2026-10-' + day + 'T02:00:00.000Z',
      status: 'completed',
      pickupCode: '0003'
    })
  }
  storage.set('local_db_v1', db)
  const page1 = backend.run('order.list', { page: 1 })
  assert.strictEqual(page1.list.length, 20)
  assert.strictEqual(page1.total, 25)
  assert.strictEqual(page1.hasMore, true)
  assert.strictEqual(page1.list[0].orderId, orderId, '最新订单排在最前')
  const page2 = backend.run('order.list', { page: 2 })
  assert.strictEqual(page2.list.length, 5)
  assert.strictEqual(page2.hasMore, false)
  const ids = page1.list.concat(page2.list).map((item) => item.orderId)
  assert.strictEqual(new Set(ids).size, 25, '分页不重复不丢单')
})

test('local ready 但无取餐码（历史订单）展示兜底标记', () => {
  const { storage, backend } = makeLocal()
  const orderId = localCreate(backend, [{ dishId: 'dish_drink', qty: 1, specOptionIds: [] }]).orderId
  backend.run('merchant.confirmReceipt', { orderId })
  backend.run('merchant.transition', { orderId, action: 'ready' })
  const db = storage.dump()
  delete db.orders[orderId].pickupCode
  storage.set('local_db_v1', db)
  const detail = backend.run('order.detail', { orderId })
  assert.strictEqual(detail.pickupCode, '')
  assert.strictEqual(detail.pickupCodeMissing, true, '应展示「请向商家询问取餐码」')
  const item = backend.run('order.list', { page: 1 }).list[0]
  assert.strictEqual(item.pickupCodeMissing, true)
})

test('local 商家看板：跨天待收款订单仍能确认收款', () => {
  const { storage, backend } = makeLocal()
  const orderId = localCreate(backend, [{ dishId: 'dish_drink', qty: 1, specOptionIds: [] }]).orderId
  const db = storage.dump()
  db.orders[orderId].date = '20261104'
  db.orders[orderId].createdAt = '2026-11-04T02:00:00.000Z'
  storage.set('local_db_v1', db)
  const board = backend.run('merchant.orders', { date: '20261105' })
  const item = board.list.filter((order) => order.orderId === orderId)[0]
  assert.ok(item, '跨天待收款订单应出现在今日看板')
  assert.strictEqual(item.isStale, true)
  assert.strictEqual(backend.run('merchant.confirmReceipt', { orderId }).order.status, 'paid')
})

test('local 打包清单按菜品+规格聚合数量', () => {
  const { backend } = makeLocal()
  const a = localCreate(backend, [
    { dishId: 'dish_hdg', qty: 2, specOptionIds: ['g1o1', 'g2o1'] },
    { dishId: 'dish_drink', qty: 1, specOptionIds: [] }
  ])
  const b = localCreate(backend, [{ dishId: 'dish_hdg', qty: 1, specOptionIds: ['g1o1', 'g2o1'] }])
  backend.run('order.markTransferred', { orderId: a.orderId, note: '' })
  backend.run('merchant.confirmReceipt', { orderId: a.orderId })
  backend.run('order.markTransferred', { orderId: b.orderId, note: '' })
  backend.run('merchant.confirmReceipt', { orderId: b.orderId })
  const list = backend.run('merchant.packing')
  assert.strictEqual(list.orderCount, 2)
  assert.strictEqual(list.itemCount, 4)
  const group = list.groups.filter((item) => item.key === 'dish_hdg::不辣 / 加卤蛋')[0]
  assert.ok(group, '应存在规格聚合组')
  assert.strictEqual(group.qty, 3)
})

test('local 收益区分已收款与待确认金额', () => {
  const { backend } = makeLocal()
  const pending = localCreate(backend, [{ dishId: 'dish_hdg', qty: 1, specOptionIds: ['g1o1'] }])
  backend.run('order.markTransferred', { orderId: pending.orderId, note: '' })
  const paid = localCreate(backend, [{ dishId: 'dish_drink', qty: 1, specOptionIds: [] }])
  backend.run('order.markTransferred', { orderId: paid.orderId, note: '' })
  backend.run('merchant.confirmReceipt', { orderId: paid.orderId })
  const result = backend.run('merchant.stats')
  assert.strictEqual(result.paidCents, 500)
  assert.strictEqual(result.paidCount, 1)
  assert.strictEqual(result.pendingConfirmCents, 2200)
  assert.strictEqual(result.pendingConfirmCount, 1)
  assert.strictEqual(result.paymentRecords.length, 1)
})

test('local jsapi 明确报 WXPAY_NOT_CONFIGURED（不白屏）', () => {
  const { backend } = makeLocal()
  expectCode(() => backend.run('jsapiPay', { orderId: 'x' }), 'WXPAY_NOT_CONFIGURED')
})

/* --------------------------- 展示层兜底 --------------------------- */
console.log('\n[展示层兜底 safeText / safeNumber]')

test('safeText 对 undefined / null / NaN / 空白串返回兜底，不把字面上屏', () => {
  assert.strictEqual(safe.safeText(undefined, '—'), '—')
  assert.strictEqual(safe.safeText(null, '—'), '—')
  assert.strictEqual(safe.safeText(NaN, '—'), '—')
  assert.strictEqual(safe.safeText('   ', '—'), '—')
  assert.strictEqual(safe.safeText('', '—'), '—')
  assert.strictEqual(safe.safeText(0, '—'), '0')
  assert.strictEqual(safe.safeText(false, '—'), 'false')
  assert.strictEqual(safe.safeText('黄焖鸡', '—'), '黄焖鸡')
  assert.strictEqual(safe.safeText(undefined), '')
})

test('safeNumber / safeInt / safeArray 对非法值兜底', () => {
  assert.strictEqual(safe.safeNumber(undefined, 0), 0)
  assert.strictEqual(safe.safeNumber(null, 7), 7)
  assert.strictEqual(safe.safeNumber(NaN, 7), 7)
  assert.strictEqual(safe.safeNumber('abc', 7), 7)
  assert.strictEqual(safe.safeNumber(Infinity, 7), 7)
  assert.strictEqual(safe.safeNumber('12', 7), 12)
  assert.strictEqual(safe.safeInt(3.9, 0), 3)
  assert.strictEqual(safe.safeInt(NaN, 5), 5)
  assert.deepStrictEqual(safe.safeArray(null), [])
  assert.deepStrictEqual(safe.safeArray(undefined), [])
  assert.deepStrictEqual(safe.safeArray([1]), [1])
})

test('旧数据字符串时段不再产生「剩undefined」', () => {
  const read = slots.readSlots(['11:30-12:00', '12:00-12:30'])
  assert.strictEqual(read.length, 2)
  assert.strictEqual(read[0].label, '11:30-12:00')
  assert.strictEqual(read[0].limit, 20)
  assert.strictEqual(read[0].id, 's1')
  const avail = slots.slotAvailability(read[0], undefined)
  for (const key of ['id', 'label', 'limit', 'used', 'left']) {
    assert.notStrictEqual(avail[key], undefined, key + ' 不应为 undefined')
  }
  assert.strictEqual(avail.left, 20)
  const legacy = slots.slotAvailability('11:30-12:00', 3)
  assert.strictEqual(legacy.label, '11:30-12:00')
  assert.strictEqual(legacy.left, 17)
  const broken = slots.slotAvailability({ label: null, limit: NaN }, NaN)
  assert.strictEqual(broken.label, '取餐时段')
  assert.strictEqual(broken.limit, 20)
  assert.strictEqual(broken.used, 0)
})

/* --------------------------- 权限守卫 --------------------------- */
console.log('\n[商家权限守卫]')

test('decideAccess 仅 isMerchant === true 放行，其余一律拒绝', () => {
  assert.deepStrictEqual(merchantGuard.decideAccess({ isMerchant: true }), {
    allowed: true,
    code: 'OK',
    message: ''
  })
  assert.strictEqual(merchantGuard.decideAccess({ isMerchant: false }).allowed, false)
  assert.strictEqual(merchantGuard.decideAccess({}).allowed, false)
  assert.strictEqual(merchantGuard.decideAccess(null).code, 'NO_MERCHANT_ACCESS')
  assert.strictEqual(merchantGuard.decideAccess({ isMerchant: 'true' }).allowed, false)
})

/* --------------------------- 菜单缓存与同源 ------------------- */
console.log('\n[菜单缓存失效与商家/顾客同源数据]')

test('菜单缓存失效会清理旧快照键', () => {
  const removed = []
  global.wx = { removeStorageSync: (key) => removed.push(key) }
  try {
    assert.strictEqual(menuCache.invalidate(), menuCache.LEGACY_KEYS.length)
    assert.deepStrictEqual(removed, menuCache.LEGACY_KEYS)
  } finally {
    delete global.wx
  }
})

test('local 商家加菜并发布后，顾客端读同一 store 能看到新菜', () => {
  const { storage, backend, at } = makeLocal()
  const beforeMenu = backend.run('menu.today')
  const ids = beforeMenu.categories
    .reduce((acc, cat) => acc.concat(cat.dishes), [])
    .map((dish) => dish._id)
  const saved = backend.run('merchant.saveDish', {
    dish: { name: '测试新菜', category: '测试', priceCents: 1234, sortOrder: 9, onSale: true }
  })
  assert.strictEqual(saved.created, true)
  backend.run('merchant.publishMenu', {
    title: '今日菜单',
    slots: beforeMenu.slots.map((slot) => ({ id: slot.id, label: slot.label, limit: slot.limit })),
    dishIds: ids.concat([saved.dishId])
  })
  // 模拟顾客端另一台页面实例：同一 storage key、同一版本
  const customer = localBackend.createLocalBackend({ storage, now() { return at } })
  const menu = customer.run('menu.today')
  const all = menu.categories.reduce((acc, cat) => acc.concat(cat.dishes), [])
  assert.strictEqual(menu.totalDishes, ids.length + 1)
  assert.ok(all.filter((dish) => dish.name === '测试新菜')[0], '顾客端应看到新菜')
  assert.strictEqual(typeof menu.menuVersion, 'number')
})

/* --------------------------- 云端失败不静默回退 --------------------------- */
console.log('\n[云端失败：显式提示，不自动切 local]')

function installEnv(app, wxMock) {
  global.wx = wxMock
  global.getApp = () => app
}

function clearEnv() {
  delete global.wx
  delete global.getApp
}

test('云端失败弹窗只给「重试/关闭」，绝不自动切到 local', () => {
  const store = {}
  const app = { globalData: { dataMode: 'cloud', cloudEnv: 'ordering-d0gyct6z1ff2afebd' } }
  let modal = null
  let retried = 0
  const relaunch = []
  installEnv(app, {
    getStorageSync: (key) => store[key],
    setStorageSync: (key, value) => { store[key] = value },
    showModal: (opts) => { modal = opts },
    showToast: () => {},
    reLaunch: (opts) => relaunch.push(opts.url)
  })
  try {
    dataSource.showError({ code: 'CALL_FAILED', message: '云函数未部署' }, '订单加载失败', {
      onRetry: () => { retried += 1 }
    })
    assert.ok(modal, '应弹出兜底提示')
    assert.strictEqual(modal.confirmText, '重试')
    assert.strictEqual(modal.cancelText, '关闭')
    assert.ok(modal.content.indexOf('CALL_FAILED') >= 0, '弹窗应展示错误码')
    assert.strictEqual(dataSource.getMode(), 'cloud')

    modal.success({ confirm: true, cancel: false })
    assert.strictEqual(retried, 1)
    assert.strictEqual(dataSource.getMode(), 'cloud', '点重试不应切模式')

    modal.success({ confirm: false, cancel: true })
    assert.strictEqual(dataSource.getMode(), 'cloud', '关闭弹窗绝不能自动切 local')
  } finally {
    dataSource.switchToCloud({ silent: true })
    clearEnv()
  }
})

test('商家端隐私模式：只显示「系统暂时不可用，请联系管理员」', () => {
  const store = {}
  const app = { globalData: { dataMode: 'cloud', cloudEnv: 'ordering-d0gyct6z1ff2afebd' } }
  let modal = null
  installEnv(app, {
    getStorageSync: (key) => store[key],
    setStorageSync: (key, value) => { store[key] = value },
    showModal: (opts) => { modal = opts },
    showToast: () => {}
  })
  try {
    dataSource.setErrorPrivacy(true)
    dataSource.showError(
      { code: 'CALL_FAILED', message: 'cloudfunctions/api 未抵达，环境 ordering-d0gyct6z1ff2afebd，集合 orders' },
      '订单加载失败'
    )
    assert.ok(modal, '应弹窗')
    assert.strictEqual(modal.title, '系统暂时不可用')
    assert.strictEqual(modal.content, '系统暂时不可用，请联系管理员。')
    assert.strictEqual(modal.confirmText, '重试')
    assert.ok(modal.content.indexOf('CALL_FAILED') < 0, '不得出现错误码')
    assert.ok(modal.content.indexOf('ordering-') < 0, '不得出现环境 ID')
    assert.ok(modal.content.indexOf('orders') < 0, '不得出现集合名')
  } finally {
    dataSource.setErrorPrivacy(false)
    dataSource.switchToCloud({ silent: true })
    clearEnv()
  }
})

testAsync('云端调用失败时模式仍为 cloud，不写本地演示数据', async () => {
  const store = {}
  const app = { globalData: { dataMode: 'cloud', cloudEnv: 'ordering-d0gyct6z1ff2afebd' } }
  installEnv(app, {
    getStorageSync: (key) => store[key],
    setStorageSync: (key, value) => { store[key] = value },
    showToast: () => {},
    reLaunch: () => {}
  })
  try {
    assert.strictEqual(dataSource.getMode(), 'cloud')
    let error = null
    try {
      await dataSource.call('menu.today')
    } catch (err) {
      error = err
    }
    assert.ok(error, '云端不可用时必须抛错')
    assert.strictEqual(error.code, 'CLOUD_UNAVAILABLE')
    assert.strictEqual(dataSource.getMode(), 'cloud')
    assert.strictEqual(store[dataSource.MODE_STORAGE_KEY], undefined)
    assert.strictEqual(store['ordering_local_db_v1'], undefined, '不应偷偷写入本地 store')
  } finally {
    clearEnv()
  }
})

testAsync('角色守卫拒绝顾客直达商家页，并跳回菜单', async () => {
  const store = {}
  const toasts = []
  const relaunch = []
  const app = { globalData: { dataMode: 'local' } }
  installEnv(app, {
    getStorageSync: (key) => store[key],
    setStorageSync: (key, value) => { store[key] = value },
    removeStorageSync: (key) => { delete store[key] },
    showToast: (opts) => toasts.push(opts.title),
    reLaunch: (opts) => relaunch.push(opts.url)
  })
  try {
    let error = null
    try {
      await merchantGuard.requireMerchant()
    } catch (err) {
      error = err
    }
    assert.ok(error, '非商家必须被拒绝')
    assert.strictEqual(error.code, 'NO_MERCHANT_ACCESS')
    assert.ok(toasts.indexOf('无商家权限') >= 0, '应提示无商家权限')
    await new Promise((resolve) => setTimeout(resolve, 320))
    assert.ok(relaunch.indexOf('/pages/menu/menu') >= 0, '应 reLaunch 回菜单页')
  } finally {
    clearEnv()
  }
})

/* --------------------------- 多租户与三层后台 --------------------------- */
console.log('\n[多租户：文档 ID 隔离]')

test('默认商家沿用旧 ID，其他商家加前缀，杜绝跨租户覆盖', () => {
  assert.strictEqual(tenant.menuIdOf('2026-11-06', 'merchant_001'), 'm_20261106')
  assert.strictEqual(tenant.menuIdOf('2026-11-06', 'merchant_abc'), 'm_merchant_abc_20261106')
  assert.strictEqual(tenant.counterIdOf('2026-11-06', 'merchant_001'), 'seq_20261106')
  assert.strictEqual(tenant.counterIdOf('2026-11-06', 'merchant_abc'), 'seq_merchant_abc_20261106')
  assert.strictEqual(tenant.paymentDocId('merchant_001'), 'payment')
  assert.strictEqual(tenant.paymentDocId('merchant_abc'), 'payment_merchant_abc')
  assert.strictEqual(tenant.normalizeMerchantId(' bad id '), '')
})

test('tenant 规则与 config 默认商家一致', () => {
  const config = require(path.join(ROOT, 'cloudfunctions', 'api', 'config'))
  assert.strictEqual(tenant.DEFAULT_MERCHANT_ID, config.DEFAULT_MERCHANT_ID)
})

console.log('\n[四类角色：action 白名单]')

test('顾客不能调用商家写接口；staff 不能发布菜单；owner 可以', () => {
  assert.strictEqual(actionPolicy.canInvoke('customer', 'merchant.saveDish'), false)
  assert.strictEqual(actionPolicy.canInvoke('customer', 'menu.today'), true)
  assert.strictEqual(actionPolicy.canInvoke('staff', 'merchant.orders'), true)
  assert.strictEqual(actionPolicy.canInvoke('staff', 'merchant.publishMenu'), false)
  assert.strictEqual(actionPolicy.canInvoke('owner', 'merchant.publishMenu'), true)
  assert.strictEqual(actionPolicy.canInvoke('owner', 'health'), false)
  assert.strictEqual(actionPolicy.canInvoke('admin', 'health'), true)
  assert.strictEqual(actionPolicy.canInvoke('admin', 'merchant.orders'), false, '平台管理员不能读订单')
  const denied = actionPolicy.decideInvoke('customer', 'merchant.exportOrders')
  assert.strictEqual(denied.allowed, false)
  assert.strictEqual(denied.code, 'FORBIDDEN')
})

test('身份判定：admin / owner / staff / customer 四种角色', () => {
  const staffDoc = { merchantId: 'merchant_b', role: 'staff', merchantIds: ['merchant_b'] }
  assert.strictEqual(identityCore.classifyIdentity({ openid: 'o1', staffDoc }).role, 'staff')
  assert.strictEqual(identityCore.classifyIdentity({ openid: 'o1', staffDoc }).merchantId, 'merchant_b')
  assert.strictEqual(identityCore.classifyIdentity({ openid: 'o1', staffDoc: { merchantId: 'merchant_b', role: 'owner' } }).role, 'owner')
  assert.strictEqual(identityCore.classifyIdentity({ openid: 'o1', isAdmin: true, defaultMerchantId: 'merchant_001' }).role, 'admin')
  const customer = identityCore.classifyIdentity({ openid: 'o2', requestedMerchantId: 'merchant_b', defaultMerchantId: 'merchant_001' })
  assert.strictEqual(customer.role, 'customer')
  assert.strictEqual(customer.merchantId, 'merchant_b')
})

test('商家停用禁止下单；跨租户订单不可访问', () => {
  const disabled = identityCore.canCreateOrder({ merchantId: 'merchant_b', merchantStatus: 'disabled' })
  assert.strictEqual(disabled.allowed, false)
  assert.strictEqual(disabled.code, 'MERCHANT_DISABLED')
  const active = identityCore.canCreateOrder({ merchantId: 'merchant_b', merchantStatus: 'active' })
  assert.strictEqual(active.allowed, true)

  const identityA = { openid: 'ownerA', role: 'owner', merchantId: 'merchant_a' }
  assert.strictEqual(identityCore.canAccessOrder(identityA, { merchantId: 'merchant_a', buyerOpenid: 'x' }), true)
  assert.strictEqual(identityCore.canAccessOrder(identityA, { merchantId: 'merchant_b', buyerOpenid: 'x' }), false, '不能读别家订单')
  assert.strictEqual(identityCore.canAccessOrder({ openid: 'buyer', role: 'customer', merchantId: 'merchant_a' }, { merchantId: 'merchant_b', buyerOpenid: 'buyer' }), true, '买家可看自己的订单')

  const denied = identityCore.decideMerchantAccess({ role: 'customer' }, { write: true })
  assert.strictEqual(denied.code, 'NO_MERCHANT_ACCESS')
  const ownerOnly = identityCore.decideMerchantAccess({ role: 'staff', merchantId: 'merchant_a' }, { ownerOnly: true })
  assert.strictEqual(ownerOnly.code, 'ROLE_FORBIDDEN')
})

console.log('\n[分类：排序 / 禁用 / 空分类]')

test('分类按 sort 排序，禁用分类不展示，空分类不出标题', () => {
  const docs = [
    { name: '饮品', sort: 3, enabled: true },
    { name: '盖饭', sort: 1, enabled: true },
    { name: '停用类', sort: 2, enabled: false }
  ]
  const dishes = [
    { name: '可乐', category: '饮品', sortOrder: 2 },
    { name: '雪碧', category: '饮品', sortOrder: 1 },
    { name: '牛肉饭', category: '盖饭', sortOrder: 0 },
    { name: '隐藏菜', category: '停用类', sortOrder: 0 },
    { name: '历史菜', category: '旧分类', sortOrder: 0 },
    { name: '无类菜', sortOrder: 0 }
  ]
  const result = categoriesCore.buildVisibleCategories(dishes, docs)
  assert.deepStrictEqual(result.categories.map((c) => c.name), ['盖饭', '饮品', '旧分类', '其他'])
  assert.strictEqual(result.categories[1].dishes[0].name, '雪碧', '组内按 sortOrder 排序')
  assert.strictEqual(result.dishCount, 5, '禁用分类的菜品不计数')
  assert.ok(result.categories.filter((c) => c.dishes.length === 0).length === 0, '空分类不输出')
})

console.log('\n[商家 token：过期 / 伪造]')

process.env.MERCHANT_TOKEN_SECRET = 'unit-test-secret-0123456789'

test('合法 token 可校验；过期与伪造 token 被拒绝', () => {
  const good = merchantToken.signMerchantToken({ merchantId: 'merchant_b', role: 'owner' })
  const verified = merchantToken.verifyMerchantToken(good)
  assert.strictEqual(verified.ok, true)
  assert.strictEqual(verified.payload.merchantId, 'merchant_b')

  const expired = merchantToken.signMerchantToken({ merchantId: 'merchant_b', exp: Date.now() - 1000 })
  assert.strictEqual(merchantToken.verifyMerchantToken(expired).code, 'TOKEN_EXPIRED')

  const parts = good.split('.')
  const forged = parts[0] + '.' + parts[1].replace(/^./, (c) => (c === 'a' ? 'b' : 'a'))
  assert.strictEqual(merchantToken.verifyMerchantToken(forged).code, 'TOKEN_FORGED')
  assert.strictEqual(merchantToken.verifyMerchantToken('bad-token').code, 'TOKEN_INVALID')
})

console.log('\n[管理台登录：错误码与首次初始化]')

test('错误码映射：关键 code 都有 message + hint', () => {
  const required = [
    'ENV_MISSING',
    'ADMINS_COLLECTION_MISSING',
    'ALREADY_INITIALIZED',
    'INVALID_CREDENTIALS',
    'TOKEN_SECRET_MISSING',
    'ANONYMOUS_REQUIRED'
  ]
  for (const code of required) {
    const mapped = adminAuthCore.fail(code)
    assert.strictEqual(mapped.code, code)
    assert.ok(mapped.message && mapped.message.length > 0, code + ' 缺少 message')
    assert.ok(mapped.hint && mapped.hint.length > 0, code + ' 缺少 hint')
  }
})

test('集合不存在 + 有初始口令 → 走 bootstrap 并自动建集合', () => {
  const plan = adminAuthCore.planLogin({
    collectionExists: false,
    adminTotal: 0,
    adminFound: false,
    tokenSecretOk: true,
    hasBootstrap: true,
    bootstrapMatches: true
  })
  assert.strictEqual(plan.ok, true)
  assert.strictEqual(plan.mode, 'bootstrap')
  assert.strictEqual(plan.createCollection, true)
})

test('集合不存在 + 无初始口令 → ADMINS_COLLECTION_MISSING', () => {
  const plan = adminAuthCore.planLogin({
    collectionExists: false,
    tokenSecretOk: true,
    hasBootstrap: false,
    bootstrapMatches: false
  })
  assert.strictEqual(plan.ok, false)
  assert.strictEqual(plan.code, 'ADMINS_COLLECTION_MISSING')
})

test('已存在管理员时再走初始化 → ALREADY_INITIALIZED，不报成密码错', () => {
  const plan = adminAuthCore.planLogin({
    collectionExists: true,
    adminTotal: 2,
    adminFound: false,
    tokenSecretOk: true,
    hasBootstrap: true,
    bootstrapMatches: true
  })
  assert.strictEqual(plan.ok, false)
  assert.strictEqual(plan.code, 'ALREADY_INITIALIZED')
  assert.ok(plan.message.indexOf('2') >= 0, '提示里应带已有管理员数量')
})

test('TOKEN_SECRET_MISSING 优先于任何写库动作', () => {
  const missing = adminAuthCore.planLogin({
    tokenSecretOk: false,
    collectionExists: false,
    hasBootstrap: true,
    bootstrapMatches: true
  })
  assert.strictEqual(missing.ok, false)
  assert.strictEqual(missing.code, 'TOKEN_SECRET_MISSING')
  assert.strictEqual(missing.code === 'TOKEN_SECRET_MISSING' && !missing.mode, true, '密钥缺失时不得返回 bootstrap')
})

test('空集合 + 未配置初始口令 → ENV_MISSING；初始口令不一致 → INVALID_CREDENTIALS', () => {
  const noEnv = adminAuthCore.planLogin({
    collectionExists: true,
    adminTotal: 0,
    adminFound: false,
    tokenSecretOk: true,
    hasBootstrap: false,
    bootstrapMatches: false
  })
  assert.strictEqual(noEnv.code, 'ENV_MISSING')

  const wrongPassword = adminAuthCore.planLogin({
    collectionExists: true,
    adminTotal: 0,
    adminFound: false,
    tokenSecretOk: true,
    hasBootstrap: true,
    bootstrapMatches: false
  })
  assert.strictEqual(wrongPassword.code, 'INVALID_CREDENTIALS')

  const badLogin = adminAuthCore.planLogin({
    collectionExists: true,
    adminTotal: 1,
    adminFound: true,
    passwordMatches: false,
    tokenSecretOk: true,
    hasBootstrap: true,
    bootstrapMatches: false
  })
  assert.strictEqual(badLogin.code, 'INVALID_CREDENTIALS')
})

test('集合缺失识别：-502005 视为缺失，权限错误不误判为缺失', () => {
  assert.strictEqual(adminAuthCore.isCollectionMissing({ errCode: -502005 }), true)
  assert.strictEqual(adminAuthCore.isCollectionMissing({ errMsg: 'database collection not exists' }), true)
  assert.strictEqual(adminAuthCore.isCollectionMissing({ errCode: -501001, errMsg: 'permission denied' }), false)
  assert.strictEqual(adminAuthCore.isCollectionMissing(null), false)
})

test('集合查询遇到权限错误 → INTERNAL_ERROR，不进入 bootstrap', () => {
  const plan = adminAuthCore.planLogin({
    collectionErrorText: 'permission denied',
    tokenSecretOk: true,
    collectionExists: false,
    hasBootstrap: true,
    bootstrapMatches: true
  })
  assert.strictEqual(plan.ok, false)
  assert.strictEqual(plan.code, 'INTERNAL_ERROR')
})

console.log('\n[管理台登录按钮状态机]')

test('状态机：idle → loading → success → idle', () => {
  const states = []
  const sm = loginStateFactory.create(function (state) {
    states.push(state)
  })
  assert.strictEqual(sm.getState(), 'idle')
  assert.strictEqual(sm.start(), true)
  assert.strictEqual(sm.getState(), 'loading')
  assert.strictEqual(sm.isBusy(), true)
  assert.strictEqual(sm.succeed(), true)
  assert.strictEqual(sm.getState(), 'idle')
  assert.strictEqual(sm.isBusy(), false)
  assert.deepStrictEqual(states, ['loading', 'success', 'idle'])
  assert.strictEqual(sm.getLastResult(), 'success')
})

test('状态机：loading 中重复点击被忽略；失败 loading → error → idle', () => {
  const sm = loginStateFactory.create()
  assert.strictEqual(sm.start(), true)
  assert.strictEqual(sm.start(), false, 'loading 期间重复点击必须被忽略')
  assert.strictEqual(sm.fail(), true)
  assert.strictEqual(sm.getState(), 'idle')
  assert.strictEqual(sm.getLastResult(), 'error')
  assert.strictEqual(sm.fail(), false, '非 loading 状态不允许再次 fail')
  assert.strictEqual(sm.reset(), true)
})

console.log('\n[错误归一化与诊断信息]')

test('safeSerialize 处理循环引用不抛异常', () => {
  const node = { name: 'root' }
  node.self = node
  node.list = [node]
  const out = adminDiagnostics.safeSerialize(node)
  assert.strictEqual(out.name, 'root')
  assert.strictEqual(out.self, '[Circular]')
})

test('describeError 保留 code/message/errMsg/errCode/requestId/HTTP/URL', () => {
  const err = new Error('匿名登录失败')
  err.code = 'ANONYMOUS_AUTH_DISABLED'
  err.errCode = 400
  err.errMsg = 'anonymous auth is disabled'
  err.requestId = 'req-123'
  err.statusCode = 400
  err.url = 'https://ordering-d0gyct6z1ff2afebd.tcloudbaseapp.com/__auth'
  const d = adminDiagnostics.describeError(err)
  assert.strictEqual(d.code, 'ANONYMOUS_AUTH_DISABLED')
  assert.strictEqual(d.message, '匿名登录失败')
  assert.strictEqual(d.errMsg, 'anonymous auth is disabled')
  assert.strictEqual(d.errCode, 400)
  assert.strictEqual(d.requestId, 'req-123')
  assert.strictEqual(d.status, 400)
  assert.ok(d.url.indexOf('__auth') >= 0)
})

test('formatErrorText 不出现「未知错误」，且带原始对象', () => {
  const err = { errMsg: 'request failed', errCode: 'UNIMPLEMENTED', requestId: 'r1' }
  const text = adminDiagnostics.formatErrorText(err)
  assert.ok(text.indexOf('未知错误') < 0)
  assert.ok(text.indexOf('UNIMPLEMENTED') >= 0)
  assert.ok(text.indexOf('request failed') >= 0)
  assert.ok(text.indexOf('原始对象') >= 0)
  assert.ok(text.indexOf('r1') >= 0)
})

test('buildDiagnostics 含 SDK 版本/origin/环境 ID/匿名结果/最后错误', () => {
  const err = { code: 'CALL_FUNCTION_FAILED', message: 'failed' }
  const text = adminDiagnostics.buildDiagnostics({
    time: '2026-11-06T00:00:00.000Z',
    origin: 'https://amy-sy0711.github.io',
    protocol: 'https:',
    envId: 'ordering-d0gyct6z1ff2afebd',
    sdkVersion: '2.17.5',
    sdkLoaded: true,
    anon: { ok: false, error: { code: 'UNIMPLEMENTED', message: 'Method Not Allowed' }, status: 400, url: 'https://x/__auth' },
    connectionMode: 'proxy',
    connectionLabel: '本地代理（仅本机）',
    httpEndpoint: 'http://127.0.0.1:8787',
    lastError: err,
    pageErrors: ['boom']
  })
  assert.ok(text.indexOf('amy-sy0711.github.io') >= 0)
  assert.ok(text.indexOf('ordering-d0gyct6z1ff2afebd') >= 0)
  assert.ok(text.indexOf('2.17.5') >= 0)
  assert.ok(text.indexOf('UNIMPLEMENTED') >= 0)
  assert.ok(text.indexOf('CALL_FUNCTION_FAILED') >= 0)
  assert.ok(text.indexOf('本地代理') >= 0)
  assert.ok(text.indexOf('boom') >= 0)
})

console.log('\n[小程序平台管理员：绑定与路由守卫]')

test('planWxLogin：已绑定直接放行', () => {
  const plan = adminAuthCore.planWxLogin({ hasUid: true, boundAdminFound: true })
  assert.strictEqual(plan.ok, true)
  assert.strictEqual(plan.mode, 'bound')
})

test('planWxLogin：未获取 openid 报 WX_CONTEXT_REQUIRED', () => {
  const plan = adminAuthCore.planWxLogin({ hasUid: false })
  assert.strictEqual(plan.code, 'WX_CONTEXT_REQUIRED')
  assert.ok(plan.hint)
})

test('planWxLogin：已有管理员但未绑定 → ADMIN_OPENID_NOT_BOUND', () => {
  const plan = adminAuthCore.planWxLogin({ hasUid: true, collectionExists: true, adminTotal: 2 })
  assert.strictEqual(plan.ok, false)
  assert.strictEqual(plan.code, 'ADMIN_OPENID_NOT_BOUND')
  assert.ok(plan.hint)
})

test('planWxLogin：账号密码正确时绑定 openid；密码错误报 INVALID_CREDENTIALS', () => {
  const okPlan = adminAuthCore.planWxLogin({
    hasUid: true,
    collectionExists: true,
    adminTotal: 1,
    hasCredentialAttempt: true,
    credentialAdminFound: true,
    passwordMatches: true
  })
  assert.strictEqual(okPlan.ok, true)
  assert.strictEqual(okPlan.mode, 'bind')
  const badPlan = adminAuthCore.planWxLogin({
    hasUid: true,
    collectionExists: true,
    adminTotal: 1,
    hasCredentialAttempt: true,
    credentialAdminFound: true,
    passwordMatches: false
  })
  assert.strictEqual(badPlan.code, 'INVALID_CREDENTIALS')
})

test('planWxLogin：空集合 + 正确初始口令 → bootstrap；口令错 → 拒绝', () => {
  const okPlan = adminAuthCore.planWxLogin({
    hasUid: true,
    collectionExists: true,
    adminTotal: 0,
    hasBootstrap: true,
    bootstrapMatches: true
  })
  assert.strictEqual(okPlan.ok, true)
  assert.strictEqual(okPlan.mode, 'bootstrap')
  const badPlan = adminAuthCore.planWxLogin({
    hasUid: true,
    collectionExists: true,
    adminTotal: 0,
    hasBootstrap: true,
    bootstrapMatches: false
  })
  assert.strictEqual(badPlan.code, 'INVALID_CREDENTIALS')
})

test('路由守卫：已绑定放行；未绑定提示绑定；其他错误拒绝并踢回首页', () => {
  assert.strictEqual(platformGuard.decidePlatformAccess({ ok: true, bound: true }).allowed, true)
  const bind = platformGuard.decidePlatformAccess({ code: 'ADMIN_OPENID_NOT_BOUND', message: '未绑定', hint: '绑定' })
  assert.strictEqual(bind.allowed, false)
  assert.strictEqual(bind.needBind, true)
  const denied = platformGuard.decidePlatformAccess({ code: 'UNAUTHORIZED', message: '无权限' })
  assert.strictEqual(denied.allowed, false)
  assert.strictEqual(denied.needBind, false)
  assert.strictEqual(platformGuard.MENU_PATH, '/pages/menu/menu')
})

console.log('\n[HTTP 访问服务与本地代理]')

test('HTTP token 解析顺序：header → query → body', () => {
  const headerEvent = { httpMethod: 'POST', headers: { 'X-Admin-Token': 'h-token' }, queryStringParameters: { token: 'q-token' } }
  assert.deepStrictEqual(httpAdapter.extractToken(headerEvent, { token: 'b-token' }), { token: 'h-token', source: 'header' })
  const queryEvent = { httpMethod: 'POST', headers: {}, queryStringParameters: { token: 'q-token' } }
  assert.deepStrictEqual(httpAdapter.extractToken(queryEvent, {}), { token: 'q-token', source: 'query' })
  assert.deepStrictEqual(httpAdapter.extractToken({ headers: {} }, { token: 'b-token' }), { token: 'b-token', source: 'body' })
  assert.deepStrictEqual(httpAdapter.extractToken({ headers: {} }, {}), { token: '', source: 'none' })
})

test('HTTP CORS：OPTIONS 预检所需的响应头齐全', () => {
  const headers = httpAdapter.corsHeaders({ headers: { origin: 'https://amy-sy0711.github.io' } }, [])
  assert.strictEqual(headers['Access-Control-Allow-Origin'], 'https://amy-sy0711.github.io')
  assert.ok(headers['Access-Control-Allow-Headers'].indexOf('x-admin-token') >= 0)
  assert.ok(headers['Access-Control-Allow-Methods'].indexOf('OPTIONS') >= 0)
  const whitelisted = httpAdapter.corsHeaders({ headers: { origin: 'https://evil.example' } }, ['https://amy-sy0711.github.io'])
  assert.strictEqual(whitelisted['Access-Control-Allow-Origin'], 'https://amy-sy0711.github.io')
})

test('HTTP body 解析：base64 / 非法 JSON / 非对象均安全处理', () => {
  assert.deepStrictEqual(httpAdapter.parseHttpBody({ body: '{"action":"health"}' }).value, { action: 'health' })
  const b64 = Buffer.from('{"action":"health"}').toString('base64')
  assert.deepStrictEqual(httpAdapter.parseHttpBody({ body: b64, isBase64Encoded: true }).value, { action: 'health' })
  assert.strictEqual(httpAdapter.parseHttpBody({ body: '{bad' }).ok, false)
  assert.strictEqual(httpAdapter.parseHttpBody({ body: '[1,2]' }).ok, false)
})

test('本地代理路由白名单：只放行平台管理接口', () => {
  assert.strictEqual(gatewayCore.isAllowedAction('merchant.list'), true)
  assert.strictEqual(gatewayCore.isAllowedAction('adminApi/merchant.setStatus'), true)
  assert.strictEqual(gatewayCore.isAllowedAction('health'), true)
  assert.strictEqual(gatewayCore.isAllowedAction('audit.list'), true)
  assert.strictEqual(gatewayCore.isAllowedAction('merchant.orders'), false)
  assert.strictEqual(gatewayCore.isAllowedAction('orders'), false)
  assert.strictEqual(gatewayCore.isAllowedAction('merchant.dishes'), false)
  assert.strictEqual(gatewayCore.isAllowedAction('stats'), false)
  assert.strictEqual(gatewayCore.isAllowedAction(''), false)
})

test('本地代理 token 解析与 CORS', () => {
  assert.strictEqual(gatewayCore.extractToken({ 'x-admin-token': 't1' }, {}), 't1')
  assert.strictEqual(gatewayCore.extractToken({}, { token: 't2' }), 't2')
  assert.strictEqual(gatewayCore.extractToken({}, {}), '')
  assert.strictEqual(gatewayCore.extractGatewayToken({ 'x-gateway-token': 'g1' }, {}), 'g1')
  assert.strictEqual(gatewayCore.extractGatewayToken({}, { gateway: 'g2' }), 'g2')
  const headers = gatewayCore.corsHeaders('https://amy-sy0711.github.io', [])
  assert.strictEqual(headers['Access-Control-Allow-Origin'], 'https://amy-sy0711.github.io')
  assert.ok(headers['Access-Control-Allow-Headers'].indexOf('x-gateway-token') >= 0)
})

test('本机口令校验：错误口令拒绝，定长比较', () => {
  assert.strictEqual(gatewayCore.checkGatewayToken('abc', 'abc'), true)
  assert.strictEqual(gatewayCore.checkGatewayToken('abd', 'abc'), false)
  assert.strictEqual(gatewayCore.checkGatewayToken('short', 'longer-token'), false)
  assert.strictEqual(gatewayCore.checkGatewayToken('', ''), true)
})

console.log('\n[本地网关：access_token 缓存与错误映射]')

test('access_token 缓存：首次获取、未过期复用、临近过期刷新', async () => {
  let now = 1000000
  let fetchCount = 0
  const cache = gatewayCore.createTokenCache({
    ttl: 7000,
    refreshBefore: 200,
    now: () => now,
    fetchToken: async () => {
      fetchCount += 1
      return { access_token: 'token-' + fetchCount, expires_in: 7200 }
    }
  })
  const first = await cache.get()
  assert.strictEqual(first, 'token-1')
  assert.strictEqual(fetchCount, 1)
  const second = await cache.get()
  assert.strictEqual(second, 'token-1')
  assert.strictEqual(fetchCount, 1)
  now += 7000 * 1000
  const third = await cache.get()
  assert.strictEqual(third, 'token-2')
  assert.strictEqual(fetchCount, 2)
})

test('access_token 缓存：并发请求共享同一次刷新', async () => {
  let resolveFetch = null
  let fetchCount = 0
  const cache = gatewayCore.createTokenCache({
    fetchToken: () => {
      fetchCount += 1
      return new Promise((resolve) => {
        resolveFetch = resolve
      })
    }
  })
  const a = cache.get()
  const b = cache.get()
  await Promise.resolve()
  await Promise.resolve()
  resolveFetch({ access_token: 'shared', expires_in: 7200 })
  const [ta, tb] = await Promise.all([a, b])
  assert.strictEqual(ta, 'shared')
  assert.strictEqual(tb, 'shared')
  assert.strictEqual(fetchCount, 1)
})

test('access_token 获取失败时抛错并可恢复', async () => {
  let fail = true
  const cache = gatewayCore.createTokenCache({
    fetchToken: async () => (fail ? { errcode: 40013, errmsg: 'invalid appid' } : { access_token: 'ok', expires_in: 7200 })
  })
  let caught = null
  try {
    await cache.get()
  } catch (err) {
    caught = err
  }
  assert.ok(caught)
  assert.strictEqual(caught.errcode, 40013)
  fail = false
  assert.strictEqual(await cache.get(), 'ok')
})

test('微信错误映射：40001/42001 可重试并刷新 token，40013 不可重试', () => {
  const expired = gatewayCore.mapWxError(42001, 'access_token expired')
  assert.strictEqual(expired.code, 'WX_42001')
  assert.strictEqual(expired.retryable, true)
  assert.ok(expired.message.indexOf('刷新') >= 0)
  const invalid = gatewayCore.mapWxError(40001, 'invalid credential')
  assert.strictEqual(invalid.retryable, true)
  const appid = gatewayCore.mapWxError(40013, 'invalid appid')
  assert.strictEqual(appid.retryable, false)
  assert.ok(appid.message.indexOf('AppID') >= 0)
  const busy = gatewayCore.mapWxError(-1, 'system error')
  assert.strictEqual(busy.retryable, true)
})

test('invokecloudfunction 响应解析：成功 / 微信错误 / 坏 JSON', () => {
  const ok = gatewayCore.parseInvokeResult({ errcode: 0, errmsg: 'ok', resp_data: '{"code":0,"data":{"list":[]}}' })
  assert.strictEqual(ok.ok, true)
  assert.deepStrictEqual(ok.data, { code: 0, data: { list: [] } })
  const wxErr = gatewayCore.parseInvokeResult({ errcode: 42001, errmsg: 'access_token expired' })
  assert.strictEqual(wxErr.ok, false)
  assert.strictEqual(wxErr.code, 'WX_42001')
  assert.strictEqual(wxErr.retryable, true)
  const bad = gatewayCore.parseInvokeResult('<html>500</html>')
  assert.strictEqual(bad.ok, false)
  assert.strictEqual(bad.code, 'BAD_UPSTREAM_JSON')
})

console.log('\n[本地网关：静态页注入配置 / 模式优先级 / adminToken 传递]')

test('网关注入配置解析：mode=gateway、base=/api、token 不丢', () => {
  const cfg = gatewayCore.buildGatewayConfig('gw-token-123', '/api')
  assert.deepStrictEqual(cfg, { mode: 'gateway', base: '/api', token: 'gw-token-123' })
  const html = '<html><head><!--GATEWAY_CONFIG--></head><body>app</body></html>'
  const out = gatewayCore.injectGatewayConfig(html, cfg)
  assert.ok(out.indexOf('<!--GATEWAY_CONFIG-->') < 0, '占位符应被替换')
  assert.ok(out.indexOf('window.__GATEWAY__ = ') >= 0)
  assert.ok(out.indexOf('"mode":"gateway"') >= 0)
  assert.ok(out.indexOf('"base":"/api"') >= 0)
  assert.ok(out.indexOf('"token":"gw-token-123"') >= 0)
  // 解析回注入的 JSON：模拟浏览器读取 window.__GATEWAY__
  const json = out.slice(out.indexOf('window.__GATEWAY__ = ') + 'window.__GATEWAY__ = '.length)
  const parsed = JSON.parse(json.slice(0, json.indexOf(';</script>')))
  assert.strictEqual(parsed.mode, 'gateway')
  assert.strictEqual(parsed.token, 'gw-token-123')
})

test('注入配置对 HTML 特殊字符安全，且无占位符时插入 head', () => {
  const cfg = gatewayCore.buildGatewayConfig('a</script><b>', '/api')
  const out = gatewayCore.injectGatewayConfig('<html><head></head><body></body></html>', cfg)
  assert.ok(out.indexOf('</script><b>') < 0, 'token 中的尖括号必须转义')
  assert.ok(out.indexOf('\\u003c') >= 0)
  assert.ok(out.indexOf('window.__GATEWAY__') > out.indexOf('<head>'))
})

test('gateway 模式优先级最高：注入后忽略本地保存的 cloud/local', () => {
  const cfg = gatewayCore.buildGatewayConfig('t', '/api')
  assert.strictEqual(gatewayCore.resolveMode(cfg, 'cloud'), 'gateway')
  assert.strictEqual(gatewayCore.resolveMode(cfg, 'local'), 'gateway')
  assert.strictEqual(gatewayCore.resolveMode(cfg, ''), 'gateway')
  assert.strictEqual(gatewayCore.resolveMode(null, 'cloud'), 'cloud')
  assert.strictEqual(gatewayCore.resolveMode(null, 'local'), 'local')
  assert.strictEqual(gatewayCore.resolveMode(null, 'weird'), 'local')
  assert.strictEqual(gatewayCore.resolveMode({ mode: 'other' }, 'cloud'), 'cloud')
})

test('/api/admin 请求体：管理员 token 提到顶层，payload 不再重复 token', () => {
  const body = gatewayCore.buildAdminRequest('admin-token', 'merchant.list', { token: 'admin-token', page: 1 })
  assert.deepStrictEqual(body, { token: 'admin-token', action: 'merchant.list', payload: { page: 1 } })
  const fromPayload = gatewayCore.buildAdminRequest('', 'adminApi/health', { token: 'inner-token' })
  assert.strictEqual(fromPayload.token, 'inner-token')
  assert.strictEqual(fromPayload.action, 'health')
  assert.strictEqual('token' in fromPayload.payload, false)
  assert.strictEqual(gatewayCore.buildAdminRequest('t', '', {}).action, '')
})

console.log('\n[平台运营后台：禁止业务明细]')

test('平台 action 白名单不含任何业务明细接口', () => {
  const names = adminPolicy.PLATFORM_ADMIN_ACTIONS
  assert.ok(names.indexOf('merchant.list') >= 0)
  assert.ok(names.indexOf('staff.bind') >= 0)
  assert.ok(names.indexOf('repair.seedDefaults') >= 0)
  for (const forbidden of adminPolicy.FORBIDDEN_BUSINESS_ACTIONS) {
    assert.strictEqual(names.indexOf(forbidden), -1, '白名单不得包含业务接口 ' + forbidden)
  }
  assert.strictEqual(adminPolicy.isForbiddenBusinessAction('merchant.orders'), true)
})

test('审计记录字段固定，不写入业务内容', () => {
  const record = adminAudit.buildAuditRecord(
    { adminId: 'a1', username: 'ops' },
    'merchant.setStatus',
    { merchantId: 'merchant_b', status: 'disabled', remark: '顾客手机号 13800000000' },
    { ok: true }
  )
  const keys = Object.keys(record)
  assert.deepStrictEqual(keys, ['actorType', 'actorId', 'actorName', 'action', 'merchantId', 'result', 'code', 'source', 'at'])
  assert.strictEqual(record.actorType, 'platform_admin')
  assert.strictEqual(record.merchantId, 'merchant_b')
  assert.ok(JSON.stringify(record).indexOf('13800000000') < 0, '审计日志不得包含业务字段值')
})

test('商家导出只包含本租户订单', () => {
  const orders = [
    { merchantId: 'merchant_a', orderNo: 'A1', status: 'paid', date: '2026-11-06', items: [{ name: '牛肉饭', qty: 1, specText: '' }], totalCents: 2000, totalQty: 1 },
    { merchantId: 'merchant_b', orderNo: 'B1', status: 'paid', date: '2026-11-06', items: [{ name: '可乐', qty: 2, specText: '' }], totalCents: 1000, totalQty: 2 }
  ]
  const result = exportCore.buildOrdersCsv(orders, 'merchant_a')
  assert.strictEqual(result.count, 1)
  assert.ok(result.csv.indexOf('A1') >= 0)
  assert.ok(result.csv.indexOf('B1') < 0, '不得导出别家订单')
  assert.ok(result.csv.indexOf('牛肉饭') >= 0)
})

/* -------------------- 菜单左栏联动 / 菜品图预览 -------------------- */
const categoryScroll = require(path.join(MINI_UTILS, 'category-scroll'))
const imagePreview = require(path.join(MINI_UTILS, 'image-preview'))

test('分类偏移换算：相对滚动容器且随 scrollTop 还原', () => {
  const atTop = categoryScroll.computeOffsets(100, [100, 500, 900], 0)
  assert.deepStrictEqual(atTop.map((item) => item.offset), [0, 400, 800])
  // 已滚动 300 时标题视口位置整体上移，位移仍应是 0/400/800
  const scrolled = categoryScroll.computeOffsets(100, [-200, 200, 600], 300)
  assert.deepStrictEqual(scrolled.map((item) => item.offset), [0, 400, 800])
  // 非法入参不崩
  assert.deepStrictEqual(categoryScroll.computeOffsets(undefined, [1], 0), [])
  assert.deepStrictEqual(categoryScroll.computeOffsets(0, ['x', undefined, 240], 0).length, 1)
})

test('分类索引边界：空分类、单分类、临界滞回', () => {
  assert.strictEqual(categoryScroll.computeActiveIndex([], 0), -1)
  assert.strictEqual(categoryScroll.computeActiveIndex(null, 100), -1)
  assert.strictEqual(categoryScroll.computeActiveIndex([0], 120), 0)
  const offsets = [0, 400, 800]
  assert.strictEqual(categoryScroll.computeActiveIndex(offsets, 0), 0)
  assert.strictEqual(categoryScroll.computeActiveIndex(offsets, 380, 12), 0, '未越过标题前保持原分类')
  assert.strictEqual(categoryScroll.computeActiveIndex(offsets, 412, 12), 1)
  assert.strictEqual(categoryScroll.computeActiveIndex(offsets, 800), 2)
  assert.strictEqual(categoryScroll.computeActiveIndex(offsets, 99999), 2, '到底部仍停在最后一个分类')
  assert.strictEqual(categoryScroll.computeActiveIndex([{ offset: 0 }, { offset: 300 }], 300), 1)
})

test('左栏显隐：0/1 个分类隐藏，多个分类显示', () => {
  assert.strictEqual(categoryScroll.shouldShowRail(0), false)
  assert.strictEqual(categoryScroll.shouldShowRail(1), false)
  assert.strictEqual(categoryScroll.shouldShowRail(2), true)
  assert.strictEqual(categoryScroll.shouldShowRail(undefined), false)
})

test('图片预览参数：只传当前菜品图，current 指向被点项', () => {
  const ok = imagePreview.previewArgs(' https://cdn.example.com/a.jpg ', [])
  assert.strictEqual(ok.ok, true)
  assert.deepStrictEqual(ok.urls, ['https://cdn.example.com/a.jpg'])
  assert.strictEqual(ok.current, 'https://cdn.example.com/a.jpg')
  const empty = imagePreview.previewArgs('', [])
  assert.strictEqual(empty.ok, false)
  assert.strictEqual(empty.reason, 'NO_IMAGE')
  assert.deepStrictEqual(empty.urls, [])
  const failed = imagePreview.previewArgs('https://cdn.example.com/b.jpg', ['https://cdn.example.com/b.jpg'])
  assert.strictEqual(failed.ok, false)
  assert.strictEqual(failed.reason, 'LOAD_FAILED')
  const nonString = imagePreview.previewArgs(null, [])
  assert.strictEqual(nonString.ok, false)
})

/* -------------------- 菜单页购物车清单弹层 -------------------- */
console.log('\n[菜单页购物车清单：分行、增减、合计、下架拦截]')

function withWxStorage(fn) {
  const store = {}
  global.wx = {
    getStorageSync: (key) => (key in store ? store[key] : ''),
    setStorageSync: (key, value) => { store[key] = value },
    showToast: () => {}
  }
  try {
    return fn(store)
  } finally {
    delete global.wx
  }
}

const cartSheet = require(path.join(MINI_UTILS, 'cart-sheet'))
const cartUtil = require(path.join(MINI_UTILS, 'cart'))

test('同菜品不同规格分行显示，单价含规格加价', () => {
  withWxStorage(() => {
    cartUtil.add({ dishId: 'd1', name: '牛肉面', specOptionIds: ['s1'], specText: '大份', specDeltaCents: 200, unitPriceCents: 1200, qty: 1 })
    cartUtil.add({ dishId: 'd1', name: '牛肉面', specOptionIds: ['s2'], specText: '小份', specDeltaCents: 0, unitPriceCents: 1200, qty: 2 })
    const rows = cartSheet.buildRows(cartUtil.load(), { d1: { _id: 'd1', imageUrl: 'https://cdn/x.jpg' } })
    assert.strictEqual(rows.length, 2, '不同规格不能合并')
    assert.strictEqual(rows[0].specText, '大份')
    assert.strictEqual(rows[1].specText, '小份')
    assert.strictEqual(rows[0].unitPriceCents, 1400)
    assert.strictEqual(rows[0].unitText, '14.00')
    assert.strictEqual(rows[1].subtotalText, '24.00')
    assert.strictEqual(rows[0].imageUrl, 'https://cdn/x.jpg', '优先用菜单最新图片')
    assert.strictEqual(rows[1].available, true)
  })
})

test('弹层合计：件数与金额随行实时汇总，空车为空态', () => {
  const rows = [
    { qty: 2, unitPriceCents: 1400 },
    { qty: 1, unitPriceCents: 500 }
  ]
  const info = cartSheet.summary(rows)
  assert.strictEqual(info.count, 3)
  assert.strictEqual(info.cents, 3300)
  assert.strictEqual(info.text, '33.00')
  assert.strictEqual(info.empty, false)
  const empty = cartSheet.summary([])
  assert.strictEqual(empty.count, 0)
  assert.strictEqual(empty.text, '0.00')
  assert.strictEqual(empty.empty, true)
})

test('数量增减：减到 0 移除，超上限给出原因不静默截断', () => {
  withWxStorage(() => {
    cartUtil.add({ dishId: 'd2', name: '凉皮', specOptionIds: [], specText: '', specDeltaCents: 0, unitPriceCents: 800, qty: 20 })
    const key = cartUtil.load()[0].key
    const over = cartSheet.stepQty(key, 1, { d2: {} })
    assert.strictEqual(over.ok, false)
    assert.strictEqual(over.reason, 'MAX_QTY')
    assert.ok(over.message.indexOf('20') >= 0)
    assert.strictEqual(cartUtil.load()[0].qty, 20, '超上限不改变数量')
    const minus = cartSheet.stepQty(key, -1, { d2: {} })
    assert.strictEqual(minus.ok, true)
    assert.strictEqual(cartUtil.load()[0].qty, 19)
    const gone = cartSheet.stepQty(key, -19, { d2: {} })
    assert.strictEqual(gone.ok, true)
    assert.strictEqual(gone.removed, true)
    assert.strictEqual(cartUtil.load().length, 0)
  })
})

test('下架/售罄菜品：标记不可加，增加被拒并给出原因', () => {
  withWxStorage(() => {
    cartUtil.add({ dishId: 'd3', name: '售罄菜', specOptionIds: [], specText: '', specDeltaCents: 0, unitPriceCents: 900, qty: 1 })
    cartUtil.add({ dishId: 'd4', name: '下架菜', specOptionIds: [], specText: '', specDeltaCents: 0, unitPriceCents: 700, qty: 1 })
    const dishMap = { d3: { _id: 'd3', soldOut: true } }
    const rows = cartSheet.buildRows(cartUtil.load(), dishMap)
    const soldOutRow = rows.filter((row) => row.dishId === 'd3')[0]
    const offShelfRow = rows.filter((row) => row.dishId === 'd4')[0]
    assert.strictEqual(soldOutRow.available, false)
    assert.strictEqual(soldOutRow.stateLabel, '售罄')
    assert.strictEqual(soldOutRow.canIncrease, false)
    assert.strictEqual(offShelfRow.available, false)
    assert.strictEqual(offShelfRow.stateLabel, '已下架')
    const soldOutTry = cartSheet.stepQty(soldOutRow.key, 1, dishMap)
    assert.strictEqual(soldOutTry.ok, false)
    assert.strictEqual(soldOutTry.reason, 'SOLD_OUT')
    const offShelfTry = cartSheet.stepQty(offShelfRow.key, 1, dishMap)
    assert.strictEqual(offShelfTry.ok, false)
    assert.strictEqual(offShelfTry.reason, 'OFF_SHELF')
    // 下架/售罄仍可减数量或直接删除
    const minus = cartSheet.stepQty(offShelfRow.key, -1, dishMap)
    assert.strictEqual(minus.removed, true)
  })
})

/* -------------------- 取餐码（原子自增、每日重置、跨商家隔离） -------------------- */
const pickupCode = require(path.join(CORE, 'pickup-code'))

function memoryPickupStore(seed) {
  const docs = {}
  if (seed) Object.keys(seed).forEach((id) => { docs[id] = { seq: seed[id] } })
  return {
    docs,
    async inc(id) {
      if (!docs[id]) return { updated: 0 }
      docs[id].seq += 1
      // 模拟事务内自增：同时返回本事务拿到的新序号
      return { updated: 1, seq: docs[id].seq }
    },
    async add(id, seq) {
      if (docs[id]) throw new Error('DUPLICATE')
      docs[id] = { seq: seq || 1 }
    },
    async read(id) {
      return docs[id] ? { seq: docs[id].seq } : null
    }
  }
}

test('取餐码格式：4 位补零，超 9999 保持 5 位并带 warning', () => {
  assert.strictEqual(pickupCode.formatPickupCode(1), '0001')
  assert.strictEqual(pickupCode.formatPickupCode(42), '0042')
  assert.strictEqual(pickupCode.formatPickupCode(9999), '9999')
  assert.strictEqual(pickupCode.formatPickupCode(10000), '10000')
  assert.strictEqual(pickupCode.formatPickupCode(0), '')
  assert.strictEqual(pickupCode.counterId('m1', '20261105'), 'pickup_seq_m1_20261105')
})

testAsync('取餐码：当日首单 0001，连续三单 0001/0002/0003', async () => {
  const store = memoryPickupStore()
  const a = await pickupCode.nextPickupCode(store, 'm1', '20261105')
  const b = await pickupCode.nextPickupCode(store, 'm1', '20261105')
  const c = await pickupCode.nextPickupCode(store, 'm1', '20261105')
  assert.deepStrictEqual([a.code, b.code, c.code], ['0001', '0002', '0003'])
  assert.deepStrictEqual([a.warning, b.warning, c.warning], ['', '', ''])
})

testAsync('取餐码：跨天重置回 0001，不同商家互不影响', async () => {
  const store = memoryPickupStore()
  await pickupCode.nextPickupCode(store, 'm1', '20261105')
  await pickupCode.nextPickupCode(store, 'm1', '20261105')
  const nextDay = await pickupCode.nextPickupCode(store, 'm1', '20261106')
  assert.strictEqual(nextDay.code, '0001')
  const otherMerchant = await pickupCode.nextPickupCode(store, 'm2', '20261105')
  assert.strictEqual(otherMerchant.code, '0001')
  const again = await pickupCode.nextPickupCode(store, 'm1', '20261105')
  assert.strictEqual(again.code, '0003', 'm2 的消耗不影响 m1')
})

testAsync('取餐码：并发自增不重号（20 个并发唯一）', async () => {
  const store = memoryPickupStore()
  const results = await Promise.all(
    Array.from({ length: 20 }, () => pickupCode.nextPickupCode(store, 'm1', '20261105'))
  )
  const codes = results.map((item) => item.code)
  assert.strictEqual(new Set(codes).size, 20, '不允许重号')
  assert.strictEqual(codes.indexOf('0001') >= 0, true)
  assert.strictEqual(codes.indexOf('0020') >= 0, true)
})

testAsync('取餐码：首次创建并发冲突后回读继续自增', async () => {
  const store = memoryPickupStore()
  const conflict = {
    docs: store.docs,
    async inc(id) {
      // 模拟：首次自增时文档刚被别人创建完毕，因此更新命中
      if (!store.docs[id]) store.docs[id] = { seq: 1 }
      store.docs[id].seq += 1
      return { updated: 1 }
    },
    async add(id) {
      throw new Error('DUPLICATE')
    },
    async read(id) {
      return store.docs[id] ? { seq: store.docs[id].seq } : null
    }
  }
  const first = await pickupCode.nextPickupCode(conflict, 'm1', '20261105')
  assert.strictEqual(first.code, '0002', '冲突后应回读已创建的计数并自增')
})

testAsync('取餐码：超过 9999 继续自增，不回落', async () => {
  const id = pickupCode.counterId('m1', '20261105')
  const store = memoryPickupStore({ [id]: 9998 })
  const a = await pickupCode.nextPickupCode(store, 'm1', '20261105')
  const b = await pickupCode.nextPickupCode(store, 'm1', '20261105')
  assert.strictEqual(a.code, '9999')
  assert.strictEqual(b.code, '10000')
  assert.ok(b.warning.indexOf('9999') >= 0)
})

/* ------------------------------ 汇总 ------------------------------ */
async function printSummary() {
  await flushAsyncTests()
  console.log('\n----------------------------------------')
  console.log('通过 ' + passed + ' 项，失败 ' + failed + ' 项')
  if (failed) {
    for (const item of failures) {
      console.log('\n失败用例：' + item.name)
      console.log(item.err && item.err.stack)
    }
    process.exit(1)
  }
  console.log('全部离线单测通过')
}

printSummary()
