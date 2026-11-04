'use strict'

const money = require('./money')
const state = require('./state')

/**
 * 当日收益聚合（纯函数，按自然日 Asia/Shanghai 由调用方传入当日订单）。
 *
 * 金额口径（全部整数分）：
 *  - paidCents（已收款金额）：状态为 paid / accepted / ready / completed 的订单合计（已取消不算）
 *  - pendingConfirmCents（待确认金额）：状态 pending_confirm（顾客自述已转账、商家未确认）
 *  - pendingPayCents（未付款金额）：状态 pending_pay
 *  - refundCents（退款/取消金额）：已收过款但被取消的订单合计
 */
function buildDailyStats(orders, options) {
  const opts = options || {}
  const list = Array.isArray(orders) ? orders : []

  let orderCount = list.length
  let paidCount = 0
  let paidCents = 0
  let paidItemCount = 0
  let pendingConfirmCount = 0
  let pendingConfirmCents = 0
  let pendingPayCount = 0
  let pendingPayCents = 0
  let canceledCount = 0
  let refundCount = 0
  let refundCents = 0

  const dishMap = {}
  const dishRank = []

  for (const order of list) {
    const totalCents = money.assertCents(order.totalCents || 0, '订单金额')
    const status = order.status

    if (state.PAID_STATUSES.indexOf(status) >= 0) {
      paidCount += 1
      paidCents = money.add(paidCents, totalCents)
      for (const item of order.items || []) {
        paidItemCount += item.qty
        if (!dishMap[item.dishId]) {
          dishMap[item.dishId] = { dishId: item.dishId, name: item.name, qty: 0, salesCents: 0 }
          dishRank.push(dishMap[item.dishId])
        }
        dishMap[item.dishId].qty += item.qty
        dishMap[item.dishId].salesCents = money.add(
          dishMap[item.dishId].salesCents,
          money.assertCents(item.lineTotalCents || 0, '菜品小计')
        )
      }
    } else if (status === state.STATUS.PENDING_CONFIRM) {
      pendingConfirmCount += 1
      pendingConfirmCents = money.add(pendingConfirmCents, totalCents)
    } else if (status === state.STATUS.PENDING_PAY) {
      pendingPayCount += 1
      pendingPayCents = money.add(pendingPayCents, totalCents)
    } else if (status === state.STATUS.CANCELED) {
      canceledCount += 1
      if (state.hasReceivedMoney(order)) {
        refundCount += 1
        refundCents = money.add(refundCents, totalCents)
      }
    }
  }

  dishRank.sort((a, b) => (b.qty - a.qty) || (b.salesCents - a.salesCents) || a.name.localeCompare(b.name))

  const avgOrderCents = paidCount > 0 ? Math.floor(paidCents / paidCount) : 0

  return {
    date: opts.date || '',
    orderCount,
    paidCount,
    paidItemCount,
    paidCents,
    paidCentsText: money.formatCents(paidCents),
    pendingConfirmCount,
    pendingConfirmCents,
    pendingConfirmCentsText: money.formatCents(pendingConfirmCents),
    pendingPayCount,
    pendingPayCents,
    pendingPayCentsText: money.formatCents(pendingPayCents),
    canceledCount,
    refundCount,
    refundCents,
    refundCentsText: money.formatCents(refundCents),
    avgOrderCents,
    avgOrderCentsText: money.formatCents(avgOrderCents),
    dishRank
  }
}

module.exports = { buildDailyStats }
