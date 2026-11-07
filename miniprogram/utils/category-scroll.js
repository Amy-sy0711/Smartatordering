/**
 * 菜单左侧分类栏与右侧列表的滚动联动（纯计算，便于离线单测）
 */

/** 分类标题相对滚动容器顶部的偏移：标题在视口的位置 - 容器视口位置 + 当前 scrollTop */
function computeOffsets(containerTop, titleTops, scrollTop) {
  const container = Number(containerTop)
  const scroll = Number(scrollTop) || 0
  const tops = Array.isArray(titleTops) ? titleTops : []
  if (!isFinite(container)) return []
  const result = []
  tops.forEach((top) => {
    const value = Number(top)
    if (!isFinite(value)) return
    result.push({ index: result.length, offset: Math.max(Math.round(value - container + scroll), 0) })
  })
  return result
}

/**
 * 根据 scrollTop 计算当前高亮分类：
 * 取最后一个 offset <= scrollTop + threshold 的分类；空分类返回 -1，单分类返回 0。
 * threshold 用于临界处的滞回，避免在标题边界来回抖动。
 */
function computeActiveIndex(offsets, scrollTop, threshold) {
  const list = (Array.isArray(offsets) ? offsets : [])
    .map((item) => (item && typeof item === 'object' ? Number(item.offset) : Number(item)))
    .filter((value) => isFinite(value))
  if (!list.length) return -1
  if (list.length === 1) return 0
  const pad = typeof threshold === 'number' && isFinite(threshold) ? threshold : 10
  const top = Math.max(Number(scrollTop) || 0, 0)
  let index = 0
  for (let i = 1; i < list.length; i += 1) {
    if (list[i] <= top + pad) index = i
  }
  return index
}

/** 分类过多时左栏需要自身纵向滚动；0/1 个分类不显示左栏 */
function shouldShowRail(count) {
  return (Number(count) || 0) > 1
}

module.exports = { computeOffsets, computeActiveIndex, shouldShowRail }
