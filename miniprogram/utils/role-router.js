'use strict'

/**
 * 启动分流纯逻辑（可单测）：
 *  1) 身份识别成功且 isMerchant === true -> 商家端
 *  2) 身份识别成功但不是商家        -> 顾客端菜单
 *  3) 身份识别失败（云端不可达等）   -> 顾客端菜单，并提示去自检
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
  if (src.isMerchant === true) {
    return { target: MERCHANT_PAGE, isMerchant: true, failed: false, errorCode: '', errorMessage: '' }
  }
  return { target: MENU_PAGE, isMerchant: false, failed: false, errorCode: '', errorMessage: '' }
}

module.exports = { MENU_PAGE, MERCHANT_PAGE, resolveStartRoute }
