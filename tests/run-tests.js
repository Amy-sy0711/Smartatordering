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

test('已收款后的合法流转：paid → accepted → ready → completed', () => {
  assert.strictEqual(state.assertAction('paid', 'accept'), 'accepted')
  assert.strictEqual(state.assertAction('accepted', 'ready'), 'ready')
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

test('local 转账闭环：pending_pay → pending_confirm → paid → accepted → ready → completed', () => {
  const { backend } = makeLocal()
  const created = localCreate(backend, [{ dishId: 'dish_drink', qty: 1, specOptionIds: [] }])
  const orderId = created.orderId
  assert.strictEqual(backend.run('order.markTransferred', { orderId }).status, 'pending_confirm')
  const confirmed = backend.run('merchant.confirmReceipt', { orderId })
  assert.strictEqual(confirmed.order.status, 'paid')
  assert.strictEqual(confirmed.record.amountCents, 500)
  assert.strictEqual(backend.run('merchant.transition', { orderId, action: 'accept' }).status, 'accepted')
  assert.strictEqual(backend.run('merchant.transition', { orderId, action: 'ready' }).status, 'ready')
  assert.strictEqual(backend.run('merchant.transition', { orderId, action: 'complete' }).status, 'completed')
  assert.strictEqual(backend.run('order.detail', { orderId }).status, 'completed')
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
