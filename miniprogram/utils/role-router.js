'use strict'

/**
 * 启动分流纯逻辑（可单测）：
 *  1) owner/staff 商家身份 -> 商家端
 *  2) 平台管理员 / 普通顾客 -> 顾客端菜单（平台管理员不进入商家端，避免接触商家业务数据）
 *  3) 身份识别失败（云端不可达等） -> 顾客端菜单，并提示联系管理员
 */

const MENU_PAGE = '/pages/menu/menu'
const MERCHANT_PAGE = '/pages/merchant/index/index'

function resolveStartRoute(input) {
  const src = input || {}
  if (src.error) {
    return {
      target: MENU_PAGE,
      isMerchant: false,
      failed: true,
      errorCode: src.error.code || 'IDENTITY_FAILED',
      errorMessage: src.error.message || '身份校验失败'
    }
  }
  if (src.isMerchant === true && src.role !== 'admin') {
    return { target: MERCHANT_PAGE, isMerchant: true, failed: false, errorCode: '', errorMessage: '' }
  }
  return { target: MENU_PAGE, isMerchant: false, failed: false, errorCode: '', errorMessage: '' }
}

module.exports = { MENU_PAGE, MERCHANT_PAGE, resolveStartRoute }
