'use strict'

/**
 * 离线单测：只依赖纯逻辑模块（不依赖 wx-server-sdk / 云环境）。
 * 运行：node tests/run-tests.js
 */

const assert = require('assert')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const CORE = path.join(ROOT, 'cloudfunctions', 'api', 'core')

const money = require(path.join(CORE, 'money'))
const dates = require(path.join(CORE, 'dates'))
const pricing = require(path.join(CORE, 'pricing'))
const slots = require(path.join(CORE, 'slots'))
const state = require(path.join(CORE, 'state'))
const packing = require(path.join(CORE, 'packing'))
const stats = require(path.join(CORE, 'stats'))
const paymode = require(path.join(CORE, 'paymode'))

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

/* ------------------------------ 汇总 ------------------------------ */
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
