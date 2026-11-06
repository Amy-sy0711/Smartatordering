/** 本地演示模式的存储适配（wx storage），只在 local 模式使用 */
function get(key) {
  try {
    return wx.getStorageSync(key)
  } catch (err) {
    console.warn('[local-store] 读取失败', err)
    return null
  }
}

function set(key, value) {
  try {
    wx.setStorageSync(key, value)
    return true
  } catch (err) {
    console.warn('[local-store] 写入失败', err)
    return false
  }
}

function remove(key) {
  try {
    wx.removeStorageSync(key)
    return true
  } catch (err) {
    return false
  }
}

module.exports = { get, set, remove }
