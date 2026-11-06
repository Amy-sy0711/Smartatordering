'use strict'

/**
 * 平台运营后台的 action 白名单（纯逻辑，可离线单测）。
 * 平台管理员 = 系统运营者，不允许读取商家业务明细（订单内容/菜品内容/顾客信息/营收明细/备注/地址）。
 * 这里只登记租户元信息、计数、状态、配置与「按 ID 的盲修复操作」。
 */

const PLATFORM_ADMIN_ACTIONS = [
  // 租户
  'merchant.list',
  'merchant.create',
  'merchant.update',
  'merchant.setStatus',
  'merchant.setFlags',
  'merchant.resetPassword',
  // 员工绑定（只涉及 openid 与租户关系）
  'staff.list',
  'staff.bind',
  'staff.unbind',
  // 健康与日志（只给计数与错误码分布）
  'health',
  'audit.list',
  'error.summary',
  // 修复工具（盲操作，只返回条数/成功失败）
  'repair.rebuildIndexes',
  'repair.seedDefaults',
  'repair.cleanOrphans',
  'repair.resetStaff',
  'repair.revokeTokens',
  'repair.refreshMenuCache',
  'repair.resendPaymentCallback',
  // 管理员自身
  'admin.changePassword'
]

/** 明令禁止出现在 adminApi / admin-console 的业务明细接口 */
const FORBIDDEN_BUSINESS_ACTIONS = [
  'merchant.orders',
  'merchant.stats',
  'merchant.orderList',
  'merchant.dishes',
  'merchant.exportOrders',
  'order.list',
  'order.detail',
  'order.view',
  'dish.list',
  'menu.detail',
  'customer.list',
  'payment.records'
]

function isPlatformAction(name) {
  return PLATFORM_ADMIN_ACTIONS.indexOf(String(name || '')) >= 0
}

function isForbiddenBusinessAction(name) {
  return FORBIDDEN_BUSINESS_ACTIONS.indexOf(String(name || '')) >= 0
}

module.exports = {
  PLATFORM_ADMIN_ACTIONS,
  FORBIDDEN_BUSINESS_ACTIONS,
  isPlatformAction,
  isForbiddenBusinessAction
}
