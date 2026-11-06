'use strict'

const { fail } = require('./errors')
const money = require('./money')

function toId(value) {
  return String(value === null || value === undefined ? '' : value)
}

/**
 * 解析单个菜品的规格选择：加价与规格文案全部以服务端菜品定义为准。
 * 前端传的 priceDelta / 名称一律不采信。
 */
function resolveSpecs(dish, optionIds) {
  const groups = Array.isArray(dish.specs) ? dish.specs : []
  const wanted = (Array.isArray(optionIds) ? optionIds : []).map(toId)
  const known = {}
  const labels = []
  const chosen = []
  let deltaCents = 0

  for (const group of groups) {
    const options = Array.isArray(group.options) ? group.options : []
    let picked = null
    for (const option of options) {
      const id = toId(option.id)
      known[id] = true
      if (!picked && wanted.indexOf(id) >= 0) picked = option
    }
    if (picked) {
      const delta = Number(picked.priceDeltaCents === undefined ? 0 : picked.priceDeltaCents)
      if (!Number.isInteger(delta)) fail('SPEC_INVALID', `规格「${picked.label}」加价必须为整数分`)
      deltaCents += delta
      labels.push(String(picked.label))
      chosen.push(toId(picked.id))
    } else if (group.required !== false) {
      fail('SPEC_REQUIRED', `请选择「${group.name || '规格'}」`)
    }
  }

  for (const id of wanted) {
    if (!known[id]) fail('SPEC_INVALID', '所选规格不存在或已下架')
  }

  return { specDeltaCents: deltaCents, specText: labels.join(' / '), specOptionIds: chosen }
}

/**
 * 服务端价格重算（下单唯一可信的金额来源）。
 *
 * @param {Object} options
 * @param {Array}  options.dishes        菜品主数据（来自 dishes 集合）
 * @param {Array}  options.cartItems     购物车行 [{dishId, qty, specOptionIds}]
 * @param {Array}  [options.menuDishIds]  今日菜单允许的菜品 ID（不传则不校验）
 * @param {Number} [options.maxQtyPerItem]
 * @param {Number} [options.maxLines]
 * @returns {{items: Array, totalCents: Number, totalQty: Number}}
 */
function recalculateOrder(options) {
  const opts = options || {}
  const dishes = Array.isArray(opts.dishes) ? opts.dishes : []
  const cartItems = opts.cartItems
  const maxQtyPerItem = Number.isInteger(opts.maxQtyPerItem) ? opts.maxQtyPerItem : 20
  const maxLines = Number.isInteger(opts.maxLines) ? opts.maxLines : 30

  if (!Array.isArray(cartItems) || cartItems.length === 0) fail('CART_EMPTY', '购物车为空')
  if (cartItems.length > maxLines) fail('CART_TOO_MANY_LINES', `购物车最多 ${maxLines} 行`)

  const dishMap = {}
  for (const dish of dishes) dishMap[toId(dish._id)] = dish
  const menuSet = {}
  if (Array.isArray(opts.menuDishIds)) {
    for (const id of opts.menuDishIds) menuSet[toId(id)] = true
  }
  const hasMenuScope = Array.isArray(opts.menuDishIds)

  // 同菜同规格合并，避免把限量拆成多行绕过校验
  const merged = []
  const mergedIndex = {}
  for (const raw of cartItems) {
    if (!raw || typeof raw !== 'object') fail('CART_ITEM_INVALID', '购物车数据不合法')
    const dishId = toId(raw.dishId)
    if (!dishId) fail('CART_ITEM_INVALID', '购物车行缺少 dishId')
    const qty = raw.qty
    if (!Number.isInteger(qty) || qty < 1) fail('CART_QTY_INVALID', '数量必须为正整数')
    const optionIds = Array.isArray(raw.specOptionIds) ? raw.specOptionIds.map(toId).sort() : []
    const key = dishId + '#' + optionIds.join(',')
    if (mergedIndex[key] !== undefined) {
      merged[mergedIndex[key]].qty += qty
    } else {
      mergedIndex[key] = merged.length
      merged.push({ dishId, qty, optionIds })
    }
  }

  const items = []
  let totalCents = 0

  for (const line of merged) {
    const dish = dishMap[line.dishId]
    if (!dish) fail('DISH_NOT_FOUND', '菜品不存在或已被删除')
    if (hasMenuScope && !menuSet[line.dishId]) fail('DISH_NOT_IN_MENU', `「${dish.name}」不在今日菜单中`)
    if (dish.onSale === false) fail('DISH_OFF_SALE', `「${dish.name}」已下架`)
    if (dish.soldOut === true) fail('DISH_SOLD_OUT', `「${dish.name}」已售罄`)
    if (line.qty > maxQtyPerItem) fail('QTY_LIMIT', `单个菜品最多 ${maxQtyPerItem} 份`)

    // 关键：单价只取服务端菜品数据，前端传入的价格/小计全部丢弃
    const baseCents = money.assertCents(dish.priceCents, `「${dish.name}」价格`)
    const spec = resolveSpecs(dish, line.optionIds)
    const unitCents = baseCents + spec.specDeltaCents
    if (unitCents < 0) fail('PRICE_INVALID', `「${dish.name}」价格不合法`)
    const lineTotalCents = money.multiply(unitCents, line.qty)
    totalCents = money.add(totalCents, lineTotalCents)

    items.push({
      dishId: line.dishId,
      name: dish.name,
      category: dish.category || '其他',
      unitPriceCents: baseCents,
      specDeltaCents: spec.specDeltaCents,
      specText: spec.specText,
      specOptionIds: spec.specOptionIds,
      qty: line.qty,
      lineTotalCents,
      imageUrl: dish.imageUrl || ''
    })
  }

  let totalQty = 0
  for (const item of items) totalQty += item.qty

  return { items, totalCents, totalQty }
}

module.exports = { recalculateOrder, resolveSpecs }
