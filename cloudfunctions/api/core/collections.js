'use strict'

/**
 * 集合名单（唯一权威来源）。
 * README「数据字典」必须与本文件保持一致；tests/static-check.js 会做交叉校验。
 */
const COLLECTIONS = {
  MERCHANTS: 'merchants',            // 商家（_id = merchantId）
  MERCHANT_STAFF: 'merchant_staff',  // 商家员工绑定（_id = openid）
  ADMINS: 'admins',                  // 平台管理员（_id = adminId，用户名 + 密码哈希）
  CATEGORIES: 'categories',          // 菜品分类（按商家隔离）
  DISHES: 'dishes',                  // 菜品主数据（含上下架、售罄、规格）
  MENUS: 'menus',                    // 每日菜单（发布记录：dishIds + 取餐时段 + 时段限量）
  ORDERS: 'orders',                  // 订单（含菜品快照、状态机、支付信息）
  SLOT_COUNTERS: 'slot_counters',    // 取餐时段名额原子计数（每菜单每时段一条）
  COUNTERS: 'counters',              // 序号计数器（订单号按商家每天一条；取餐码 pickup_seq_<merchantId>_<yyyyMMdd>）
  ADMINS_LEGACY: 'merchant_admins',  // 旧版商家 openid 白名单（仅迁移/兼容）
  AUDIT_LOGS: 'audit_logs',          // 管理/导出操作审计（不含业务字段值）
  ERROR_LOGS: 'error_logs',          // 云函数失败日志（仅 action/code/merchantId/时间）
  SETTINGS: 'settings',              // 云端配置，按商家隔离（payment_<merchantId>）
  PAYMENT_RECORDS: 'payment_records' // 收款记录（商家确认收款时落库，用于对账）
}

const COLLECTION_LIST = Object.keys(COLLECTIONS).map((k) => COLLECTIONS[k])

module.exports = { COLLECTIONS, COLLECTION_LIST }
