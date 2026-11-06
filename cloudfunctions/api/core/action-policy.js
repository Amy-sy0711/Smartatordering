'use strict'

/**
 * 四类角色的 action 白名单（纯逻辑，可离线单测）。
 * 云函数入口先按白名单拦截，handler 内再做 ownerOnly / merchantId 归属校验。
 *
 * 平台管理员没有业务 action：管理员只走 adminApi（只返回租户元信息与计数）。
 */

const CUSTOMER_ACTIONS = [
  'whoami',
  'menu.today',
  'settings.payment',
  'order.create',
  'order.list',
  'order.detail',
  'order.markTransferred',
  'order.cancel',
  'order.reorder',
  'merchant.checkAccess'
]

const STAFF_ACTIONS = CUSTOMER_ACTIONS.concat([
  'merchant.listDishes',
  'merchant.menuHistory',
  'merchant.menuDetail',
  'merchant.orders',
  'merchant.transition',
  'merchant.confirmReceipt',
  'merchant.packing',
  'merchant.setPacked',
  'merchant.stats',
  'merchant.getPaymentSettings',
  'merchant.listCategories'
])

const OWNER_ACTIONS = STAFF_ACTIONS.concat([
  'merchant.saveDish',
  'merchant.toggleDish',
  'merchant.deleteDish',
  'merchant.saveCategory',
  'merchant.deleteCategory',
  'merchant.publishMenu',
  'merchant.copyMenu',
  'merchant.savePaymentSettings',
  'merchant.staffList',
  'merchant.staffBind',
  'merchant.staffUnbind',
  'merchant.exportOrders'
])

const ROLE_ACTIONS = {
  customer: CUSTOMER_ACTIONS,
  staff: STAFF_ACTIONS,
  owner: OWNER_ACTIONS,
  // 平台管理员在小程序内只允许身份识别与系统健康，禁止读取任何商家业务数据
  admin: ['whoami', 'health']
}

function actionsForRole(role) {
  return (ROLE_ACTIONS[String(role || '')] || []).slice()
}

function canInvoke(role, action) {
  return actionsForRole(role).indexOf(String(action || '')) >= 0
}

/**
 * @returns {{allowed:boolean, code:string, message:string}}
 */
function decideInvoke(role, action) {
  const name = String(action || '')
  if (!name) return { allowed: false, code: 'UNKNOWN_ACTION', message: '缺少接口名' }
  if (canInvoke(role, name)) return { allowed: true, code: 'OK', message: '' }
  return { allowed: false, code: 'FORBIDDEN', message: '当前角色无权调用该接口：' + name }
}

module.exports = {
  CUSTOMER_ACTIONS,
  STAFF_ACTIONS,
  OWNER_ACTIONS,
  ROLE_ACTIONS,
  actionsForRole,
  canInvoke,
  decideInvoke
}
