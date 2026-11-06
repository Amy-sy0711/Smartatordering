'use strict'

const money = require('./money')

/**
 * 商家导出（纯逻辑，可离线单测）。
 * 只导出 merchantId 匹配的订单；跨租户文档一律丢弃，避免导出混入别家数据。
 */

function csvCell(value) {
  const text = value === undefined || value === null ? '' : String(value)
  if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"'
  return text
}

function orderStatusText(status) {
  const map = {
    pending_pay: '待支付',
    pending_confirm: '待确认收款',
    paid: '已收款',
    accepted: '已接单',
    ready: '已出餐',
    completed: '已完成',
    canceled: '已取消'
  }
  return map[status] || '未知状态'
}

function buildOrdersCsv(orders, merchantId) {
  const list = (Array.isArray(orders) ? orders : []).filter(
    (order) => order && String(order.merchantId || '') === String(merchantId || '')
  )
  const header = ['订单号', '日期', '状态', '菜品明细', '数量', '金额(元)', '取餐时段', '备注']
  const rows = [header.join(',')]
  for (const order of list) {
    const items = Array.isArray(order.items) ? order.items : []
    const summary = items
      .map((item) => (item.name || '菜品') + (item.specText ? '(' + item.specText + ')' : '') + '×' + (Number(item.qty) || 0))
      .join('；')
    const cents = Number.isInteger(order.totalCents) ? order.totalCents : 0
    rows.push(
      [
        order.orderNo || '',
        order.date || '',
        orderStatusText(order.status),
        summary,
        Number(order.totalQty) || 0,
        money.formatCents(cents),
        (order.pickupSlot && order.pickupSlot.label) || '',
        order.remark || ''
      ]
        .map(csvCell)
        .join(',')
    )
  }
  return { csv: rows.join('\r\n'), count: list.length }
}

module.exports = { buildOrdersCsv, csvCell, orderStatusText }
