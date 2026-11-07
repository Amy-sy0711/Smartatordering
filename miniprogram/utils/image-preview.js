/** 菜品图预览：组装 wx.previewImage 参数，无图/加载失败不弹预览 */
function previewArgs(imageUrl, failed) {
  const url = typeof imageUrl === 'string' ? imageUrl.trim() : ''
  if (!url) return { ok: false, urls: [], current: '', reason: 'NO_IMAGE' }
  if (Array.isArray(failed) && failed.indexOf(url) >= 0) {
    return { ok: false, urls: [], current: '', reason: 'LOAD_FAILED' }
  }
  return { ok: true, urls: [url], current: url, reason: '' }
}

/** 点击菜品图：有图才预览；失败给轻提示，不阻塞主流程 */
function previewDish(imageUrl, failed) {
  const args = previewArgs(imageUrl, failed)
  if (!args.ok) {
    if (typeof wx !== 'undefined' && wx.showToast) {
      wx.showToast({ title: args.reason === 'NO_IMAGE' ? '该菜品暂无图片' : '图片暂时无法查看', icon: 'none' })
    }
    return false
  }
  if (typeof wx !== 'undefined' && wx.previewImage) {
    wx.previewImage({
      urls: args.urls,
      current: args.current,
      fail: () => wx.showToast({ title: '图片暂时无法查看', icon: 'none' })
    })
  }
  return true
}

module.exports = { previewArgs, previewDish }
