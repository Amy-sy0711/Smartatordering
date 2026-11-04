/** 订单状态展示映射（与 cloudfunctions/api/core/state.js 保持一致） */
const STATUS_TEXT = {
  pending_pay: '待付款',
  pending_confirm: '待确认收款',
  paid: '待接单',
  accepted: '制作中',
  ready: '可取餐',
  completed: '已完成',
  canceled: '已取消'
}

const STATUS_TAG_CLASS = {
  pending_pay: 'tag--warn',
  pending_confirm: 'tag--warn',
  paid: 'tag--info',
  accepted: 'tag--info',
  ready: 'tag--success',
  completed: 'tag--muted',
  canceled: 'tag--danger'
}

function text(status) {
  return STATUS_TEXT[status] || status || '未知'
}

function tagClass(status) {
  return STATUS_TAG_CLASS[status] || 'tag--muted'
}

const ACTION_TEXT = {
  pay: '支付',
  transfer: '我已转账',
  confirm: '确认已收款',
  accept: '接单',
  ready: '出餐',
  complete: '完成',
  cancel: '取消订单'
}

function actionText(action) {
  return ACTION_TEXT[action] || action
}

module.exports = { STATUS_TEXT, STATUS_TAG_CLASS, text, tagClass, actionText }
