'use strict'

/**
 * 集合名单（唯一权威来源）。
 * README「数据字典」必须与本文件保持一致；tests/static-check.js 会做交叉校验。
 */
const COLLECTIONS = {
  DISHES: 'dishes',                  // 菜品主数据（含上下架、售罄、规格）
  MENUS: 'menus',                    // 每日菜单（发布记录：dishIds + 取餐时段 + 时段限量）
  ORDERS: 'orders',                  // 订单（含菜品快照、状态机、支付信息）
  SLOT_COUNTERS: 'slot_counters',    // 取餐时段名额原子计数（每菜单每时段一条）
  COUNTERS: 'counters',              // 订单号序号计数器（每天一条）
  ADMINS: 'merchant_admins',         // 商家 openid 白名单（动态扩展，可自助 bootstrap）
  SETTINGS: 'settings',              // 云端配置，目前为 payment 支付配置
  PAYMENT_RECORDS: 'payment_records' // 收款记录（商家确认收款时落库，用于对账）
}

const COLLECTION_LIST = Object.keys(COLLECTIONS).map((k) => COLLECTIONS[k])

module.exports = { COLLECTIONS, COLLECTION_LIST }
