'use strict'

const money = require('./money')

/**
 * 打包清单聚合（纯函数）。
 * 口径：当日「已收款且未完成」的订单（paid / accepted / ready）。
 *
 * @param {Array} orders [{orderId, orderNo, pickupSlot:{label}, items, packed, remark, createdAt}]
 * @param {Object} [options] {dateLabel}
 */
function buildPackingList(orders, options) {
  const opts = options || {}
  const list = Array.isArray(orders) ? orders : []

  const groups = []
  const groupIndex = {}
  const dishTotals = []
  const dishIndex = {}

  for (const order of list) {
    for (const item of order.items || []) {
      const dishId = String(item.dishId)
      const specText = String(item.specText || '')
      const key = dishId + '::' + specText
      let group = groupIndex[key]
      if (!group) {
        group = { key, dishId, name: item.name || dishId, specText, qty: 0, orders: [] }
        groupIndex[key] = group
        groups.push(group)
      }
      group.qty += item.qty
      group.orders.push({ orderNo: order.orderNo, qty: item.qty })

      if (!dishIndex[dishId]) {
        dishIndex[dishId] = { dishId, name: item.name || dishId, qty: 0 }
        dishTotals.push(dishIndex[dishId])
      }
      dishIndex[dishId].qty += item.qty
    }
  }

  groups.sort((a, b) => (b.qty - a.qty) || a.name.localeCompare(b.name))
  dishTotals.sort((a, b) => (b.qty - a.qty) || a.name.localeCompare(b.name))

  const orderRows = list
    .slice()
    .sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return (ta - tb) || String(a.orderNo).localeCompare(String(b.orderNo))
    })
    .map((order) => {
      let itemCount = 0
      for (const item of order.items || []) itemCount += item.qty
      return {
        orderId: order._id || order.orderId,
        orderNo: order.orderNo,
        slotLabel: (order.pickupSlot && order.pickupSlot.label) || '',
        packed: order.packed === true,
        remark: order.remark || '',
        itemCount,
        items: (order.items || []).map((item) => ({
          name: item.name,
          specText: item.specText || '',
          qty: item.qty
        }))
      }
    })

  let itemCount = 0
  let totalCents = 0
  for (const order of list) {
    for (const item of order.items || []) itemCount += item.qty
    totalCents = money.add(totalCents, money.assertCents(order.totalCents || 0, '订单金额'))
  }

  const result = {
    date: opts.date || '',
    orderCount: list.length,
    itemCount,
    totalCents,
    groups,
    dishTotals,
    orders: orderRows
  }
  result.text = packingText(result, opts.dateLabel || opts.date || '')
  return result
}

/** 生成可复制/可打印的纯文本清单 */
function packingText(list, dateLabel) {
  const lines = []
  lines.push(`打包清单 ${dateLabel || list.date || ''}`.trim())
  lines.push(`共 ${list.orderCount} 单 / ${list.itemCount} 份`)

  lines.push('')
  lines.push('【按菜品汇总】')
  if (list.groups.length === 0) {
    lines.push('- 暂无待打包菜品')
  } else {
    for (const group of list.groups) {
      lines.push(`- ${group.name}${group.specText ? '（' + group.specText + '）' : ''} x${group.qty}`)
    }
  }

  lines.push('')
  lines.push('【逐单明细】')
  if (list.orders.length === 0) {
    lines.push('- 暂无订单')
  } else {
    for (const order of list.orders) {
      lines.push(`#${order.orderNo} ${order.slotLabel} 共${order.itemCount}份${order.packed ? ' [已打包]' : ''}`)
      for (const item of order.items) {
        lines.push(`  ${item.name}${item.specText ? '（' + item.specText + '）' : ''} x${item.qty}`)
      }
      if (order.remark) lines.push(`  备注：${order.remark}`)
    }
  }

  return lines.join('\n')
}

module.exports = { buildPackingList, packingText }
