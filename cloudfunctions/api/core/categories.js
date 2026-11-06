'use strict'

/**
 * 顾客端分类分组（纯逻辑，可离线单测）。
 * 规则：
 *  - 分类按 sort 升序；enabled === false 的分类整组不展示（其下菜品也不展示）
 *  - 空分类不输出标题
 *  - 菜品里出现但分类表没有的名字，放到末尾（兼容历史数据）
 *  - 组内菜品按 sortOrder / 名称排序
 */

function sortCategoryDocs(categoryDocs) {
  return (Array.isArray(categoryDocs) ? categoryDocs : [])
    .filter((doc) => doc && doc.name)
    .slice()
    .sort((a, b) => {
      const ao = Number(a.sort)
      const bo = Number(b.sort)
      const an = Number.isFinite(ao) ? ao : 0
      const bn = Number.isFinite(bo) ? bo : 0
      return an - bn || String(a.name).localeCompare(String(b.name))
    })
}

function sortDishes(dishes) {
  return (Array.isArray(dishes) ? dishes : [])
    .slice()
    .sort((a, b) => {
      const ao = Number.isInteger(a.sortOrder) ? a.sortOrder : 0
      const bo = Number.isInteger(b.sortOrder) ? b.sortOrder : 0
      return ao - bo || String(a.name || '').localeCompare(String(b.name || ''))
    })
}

/**
 * @param {Array} dishes 已过滤（在售）的菜品
 * @param {Array} categoryDocs categories 集合文档
 * @param {Function} [view] 菜品展示映射，默认原样返回
 * @returns {{categories:Array, dishCount:number}}
 */
function buildVisibleCategories(dishes, categoryDocs, view) {
  const mapDish = typeof view === 'function' ? view : (dish) => dish
  const docs = sortCategoryDocs(categoryDocs)
  const byName = {}
  const disabled = {}
  for (const doc of categoryDocs || []) {
    if (!doc || !doc.name) continue
    byName[String(doc.name)] = doc
    if (doc.enabled === false) disabled[String(doc.name)] = true
  }
  for (const doc of docs) disabled[String(doc.name)] = doc.enabled === false

  const groups = []
  const byGroup = {}
  function bucketOf(name) {
    const key = String(name || '其他')
    if (!byGroup[key]) {
      byGroup[key] = { name: key, dishes: [] }
      groups.push(byGroup[key])
    }
    return byGroup[key]
  }
  for (const doc of docs) {
    if (doc.enabled !== false) bucketOf(doc.name)
  }

  const unknown = []
  let dishCount = 0
  for (const dish of dishes || []) {
    if (!dish) continue
    const name = String(dish.category || '其他')
    if (disabled[name]) continue
    if (!byName[name] && unknown.indexOf(name) < 0) unknown.push(name)
    bucketOf(name).dishes.push(mapDish(dish))
    dishCount += 1
  }
  for (const name of unknown) bucketOf(name)

  for (const group of groups) group.dishes = sortDishes(group.dishes)
  // 空分类不输出标题
  return { categories: groups.filter((group) => group.dishes.length > 0), dishCount }
}

module.exports = { sortCategoryDocs, sortDishes, buildVisibleCategories }
