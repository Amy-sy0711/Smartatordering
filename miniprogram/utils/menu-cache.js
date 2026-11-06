'use strict'

/**
 * 菜单缓存失效钩子。
 * 顾客端每次进入 / 下拉刷新都会重新调用 menu.today，本身不持久化菜单快照；
 * 这里统一清理历史版本可能残留的本地快照键，避免商家发布后仍看到旧菜单。
 */

const LEGACY_KEYS = ['ordering_menu_cache_v1', 'ordering_menu_snapshot_v1']

function invalidate() {
  if (typeof wx === 'undefined' || !wx.removeStorageSync) return 0
  let removed = 0
  for (const key of LEGACY_KEYS) {
    try {
      wx.removeStorageSync(key)
      removed += 1
    } catch (err) {
      console.warn('[menu-cache] 清理失败：' + key, err)
    }
  }
  return removed
}

module.exports = { invalidate, LEGACY_KEYS }
