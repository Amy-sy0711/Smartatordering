/** 本地购物车（只做展示与提交，金额最终由云函数重算） */
const money = require('./money')

const KEY = 'order_cart_v1'
const MAX_QTY = 20

function load() {
  try {
    const list = wx.getStorageSync(KEY)
    return Array.isArray(list) ? list : []
  } catch (err) {
    return []
  }
}

function save(list) {
  try {
    wx.setStorageSync(KEY, list)
  } catch (err) {
    console.warn('购物车保存失败', err)
  }
}

function lineKey(dishId, specOptionIds) {
  const ids = Array.isArray(specOptionIds) ? specOptionIds.slice().sort() : []
  return String(dishId) + '#' + ids.join(',')
}

function totals(list) {
  const items = Array.isArray(list) ? list : []
  let count = 0
  const cents = items.map((line) => {
    count += line.qty
    return money.assertCents(line.unitPriceCents + (line.specDeltaCents || 0)) * line.qty
  })
  return {
    count,
    cents: money.sumCents(cents),
    text: money.formatCents(money.sumCents(cents))
  }
}

/** 加购：同菜同规格自动合并，单行不超过 20 份 */
function add(line) {
  const list = load()
  const key = lineKey(line.dishId, line.specOptionIds)
  const found = list.filter((item) => item.key === key)[0]
  if (found) {
    found.qty = Math.min(found.qty + line.qty, MAX_QTY)
  } else {
    list.push({
      key,
      dishId: line.dishId,
      name: line.name,
      specOptionIds: line.specOptionIds || [],
      specText: line.specText || '',
      specDeltaCents: line.specDeltaCents || 0,
      unitPriceCents: money.assertCents(line.unitPriceCents || 0),
      imageUrl: line.imageUrl || '',
      qty: Math.min(line.qty || 1, MAX_QTY)
    })
  }
  save(list)
  return totals(list)
}

function setQty(key, qty) {
  const list = load()
  const found = list.filter((item) => item.key === key)[0]
  if (!found) return totals(list)
  if (qty <= 0) return remove(key)
  found.qty = Math.min(qty, MAX_QTY)
  save(list)
  return totals(list)
}

function remove(key) {
  const list = load().filter((item) => item.key !== key)
  save(list)
  return totals(list)
}

function clear() {
  save([])
}

function toServerPayload(list) {
  return (Array.isArray(list) ? list : []).map((line) => ({
    dishId: line.dishId,
    qty: line.qty,
    specOptionIds: line.specOptionIds || []
  }))
}

module.exports = { KEY, MAX_QTY, load, save, lineKey, totals, add, setQty, remove, clear, toServerPayload }
