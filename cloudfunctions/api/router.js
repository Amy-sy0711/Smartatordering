'use strict'

const menuHandler = require('./handlers/menu')
const orderHandler = require('./handlers/order')
const merchantHandler = require('./handlers/merchant')
const healthHandler = require('./handlers/health')

/** action -> handler（前端只通过这张表调用云函数） */
module.exports = {
  // 自检（只读）
  'health': healthHandler.health,

  // 启动身份识别（登录 → whoami → 分流）
  'whoami': merchantHandler.whoami,
  'merchant.claimSelf': merchantHandler.claimSelf,

  // 顾客端
  'menu.today': menuHandler.today,
  'settings.payment': menuHandler.payment,
  'order.create': orderHandler.create,
  'order.list': orderHandler.list,
  'order.detail': orderHandler.detail,
  'order.markTransferred': orderHandler.markTransferred,
  'order.cancel': orderHandler.cancel,
  'order.reorder': orderHandler.reorder,

  // 商家端（全部在 handler 内部做白名单校验）
  'merchant.checkAccess': merchantHandler.checkAccess,
  'merchant.listDishes': merchantHandler.listDishes,
  'merchant.saveDish': merchantHandler.saveDish,
  'merchant.toggleDish': merchantHandler.toggleDish,
  'merchant.deleteDish': merchantHandler.deleteDish,
  'merchant.listCategories': merchantHandler.listCategories,
  'merchant.saveCategory': merchantHandler.saveCategory,
  'merchant.deleteCategory': merchantHandler.deleteCategory,
  'merchant.staffList': merchantHandler.staffList,
  'merchant.staffBind': merchantHandler.staffBind,
  'merchant.staffUnbind': merchantHandler.staffUnbind,
  'merchant.exportOrders': merchantHandler.exportOrders,
  'merchant.publishMenu': merchantHandler.publishMenu,
  'merchant.copyMenu': merchantHandler.copyMenu,
  'merchant.menuHistory': merchantHandler.menuHistory,
  'merchant.menuDetail': merchantHandler.menuDetail,
  'merchant.orders': merchantHandler.orders,
  'merchant.transition': merchantHandler.transition,
  'merchant.confirmReceipt': merchantHandler.confirmReceipt,
  'merchant.packing': merchantHandler.packing,
  'merchant.setPacked': merchantHandler.setPacked,
  'merchant.stats': merchantHandler.stats,
  'merchant.getPaymentSettings': merchantHandler.getPaymentSettings,
  'merchant.savePaymentSettings': merchantHandler.savePaymentSettings
}
