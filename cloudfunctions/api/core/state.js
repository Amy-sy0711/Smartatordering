'use strict'

const { fail } = require('./errors')

/**
 * 订单状态机（唯一权威定义）：
 *
 *   pending_pay ──(顾客转账/点击我已转账)──> pending_confirm ──(商家确认收款)──> paid
 *        │                                        │                            │
 *        └──────────(mock/jsapi 支付成功)──────────┴────────────────────────────┘
 *                                                                              ↓
 *                                                        paid ──接单──> accepted ──出餐──> ready ──完成──> completed
 *   以上任一非终态均可 cancel → canceled（终态）
 */
const STATUS = {
  PENDING_PAY: 'pending_pay',
  PENDING_CONFIRM: 'pending_confirm',
  PAID: 'paid',
  ACCEPTED: 'accepted',
  READY: 'ready',
  COMPLETED: 'completed',
  CANCELED: 'canceled'
}

const STATUS_TEXT = {
  pending_pay: '待付款',
  pending_confirm: '待确认收款',
  paid: '待接单',
  accepted: '制作中',
  ready: '可取餐',
  completed: '已完成',
  canceled: '已取消'
}

/** 顾客端展示文案（商家端仍用 STATUS_TEXT） */
const CUSTOMER_STATUS_TEXT = {
  pending_pay: '待支付',
  pending_confirm: '待商家确认',
  paid: '已支付备餐中',
  accepted: '已支付备餐中',
  ready: '待取餐',
  completed: '已取餐',
  canceled: '已取消'
}

/** 出餐完成（ready）起生成取餐码，取餐后（completed）仍展示 */
const PICKUP_CODE_STATUSES = ['ready', 'completed']

const TRANSITIONS = {
  pending_pay: ['pending_confirm', 'paid', 'canceled'],
  pending_confirm: ['paid', 'canceled'],
  paid: ['accepted', 'canceled'],
  accepted: ['ready', 'canceled'],
  ready: ['completed', 'canceled'],
  completed: [],
  canceled: []
}

/** 动作 -> 目标状态 + 允许的来源状态（非法来源一律拒绝） */
const ACTION_RULES = {
  transfer: { to: 'pending_confirm', from: ['pending_pay'] },      // 顾客：我已转账
  pay: { to: 'paid', from: ['pending_pay'] },                      // mock/jsapi 支付成功
  confirm: { to: 'paid', from: ['pending_pay', 'pending_confirm'] }, // 商家：确认收款（顾客已转账或钱已到账）
  accept: { to: 'accepted', from: ['paid'] },                      // 商家：接单（必须已收款）
  ready: { to: 'ready', from: ['accepted'] },                      // 商家：出餐
  complete: { to: 'completed', from: ['ready'] },                  // 商家：完成
  cancel: { to: 'canceled', from: ['pending_pay', 'pending_confirm', 'paid', 'accepted', 'ready'] }
}

/** 支付后、未完成的订单（打包清单口径） */
const UNFINISHED_PAID_STATUSES = ['paid', 'accepted', 'ready']
/** 已收款订单（收益口径，已取消的不算） */
const PAID_STATUSES = ['paid', 'accepted', 'ready', 'completed']

function canTransition(from, to) {
  const list = TRANSITIONS[from]
  return !!list && list.indexOf(to) >= 0
}

function assertTransition(from, to) {
  if (!STATUS_TEXT[from]) fail('UNKNOWN_STATUS', '未知的订单状态：' + String(from))
  if (!STATUS_TEXT[to]) fail('UNKNOWN_STATUS', '未知的订单状态：' + String(to))
  if (!canTransition(from, to)) {
    fail('ILLEGAL_TRANSITION', `不允许从「${STATUS_TEXT[from]}」变更为「${STATUS_TEXT[to]}」`)
  }
  return to
}

function targetOfAction(action) {
  const rule = ACTION_RULES[action]
  if (!rule) fail('UNKNOWN_ACTION', '未知的订单动作：' + String(action))
  return rule.to
}

/** 校验「当前状态 + 动作」是否合法，返回目标状态 */
function assertAction(from, action) {
  const rule = ACTION_RULES[action]
  if (!rule) fail('UNKNOWN_ACTION', '未知的订单动作：' + String(action))
  if (rule.from.indexOf(from) < 0) {
    fail(
      'ILLEGAL_TRANSITION',
      `当前状态「${STATUS_TEXT[from] || from}」不能执行该操作（要求来源状态：${rule.from
        .map((s) => STATUS_TEXT[s])
        .join(' / ')}）`
    )
  }
  return assertTransition(from, rule.to)
}

function isPaid(order) {
  return !!order && PAID_STATUSES.indexOf(order.status) >= 0
}

function hasReceivedMoney(order) {
  return !!order && (!!order.paidAt || !!order.confirmedAt)
}

module.exports = {
  STATUS,
  STATUS_TEXT,
  CUSTOMER_STATUS_TEXT,
  PICKUP_CODE_STATUSES,
  TRANSITIONS,
  ACTION_RULES,
  UNFINISHED_PAID_STATUSES,
  PAID_STATUSES,
  canTransition,
  assertTransition,
  targetOfAction,
  assertAction,
  isPaid,
  hasReceivedMoney
}
