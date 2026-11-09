/** 菜单页「购物车清单」弹层的纯计算：行组装、数量增减、合计（便于离线单测） */
const money = require('./money')
const cartUtil = require('./cart')

/** 菜单里是否还能下单：菜品存在且未售罄 */
function dishState(dish) {
  if (!dish) return { available: false, reason: 'OFF_SHELF', label: '已下架' }
  if (dish.soldOut) return { available: false, reason: 'SOLD_OUT', label: '售罄' }
  return { available: true, reason: '', label: '' }
}

/**
 * 组装弹层行：同菜不同规格各自成行（key 已含规格），单价含规格加价。
 * dishMap 来自当前菜单（用于取最新图片并判断下架/售罄）。
 */
function buildRows(lines, dishMap) {
  const list = Array.isArray(lines) ? lines : []
  const map = dishMap || {}
  return list.map((line) => {
    const dish = map[line.dishId]
    const state = dishState(dish)
    const unitPriceCents = money.assertCents(line.unitPriceCents + (line.specDeltaCents || 0))
    const qty = Number(line.qty) || 0
    return {
      key: line.key,
      dishId: line.dishId,
      name: line.name,
      initial: String(line.name || '菜').slice(0, 1),
      specText: line.specText || '',
      imageUrl: (dish && dish.imageUrl) || line.imageUrl || '',
      qty,
      maxQty: cartUtil.MAX_QTY,
      unitPriceCents,
      unitText: money.formatCents(unitPriceCents),
      subtotalText: money.formatCents(unitPriceCents * qty),
      available: state.available,
      stateLabel: state.label,
      canIncrease: state.available && qty < cartUtil.MAX_QTY
    }
  })
}

/** 合计：件数与金额都按行实时重算 */
function summary(rows) {
  const list = Array.isArray(rows) ? rows : []
  let count = 0
  const cents = list.map((row) => {
    count += Number(row.qty) || 0
    return money.assertCents(row.unitPriceCents) * (Number(row.qty) || 0)
  })
  const total = money.sumCents(cents)
  return { count, cents: total, text: money.formatCents(total), empty: list.length === 0 }
}

/**
 * 增减某行数量：返回新购物车与结果原因。
 * delta>0 时：菜品下架/售罄禁止加；达到上限给出提示而不是静默截断。
 * 数量减到 0 即从购物车移除该行。
 */
function stepQty(key, delta, dishMap) {
  const list = cartUtil.load()
  const found = list.filter((line) => line.key === key)[0]
  if (!found) return { ok: false, reason: 'NOT_FOUND', message: '该菜品已不在购物车', lines: list }
  const dish = (dishMap || {})[found.dishId]
  const step = Number(delta) || 0
  if (step === 0) return { ok: true, reason: '', message: '', lines: list, removed: false }
  if (step > 0) {
    const state = dishState(dish)
    if (!state.available) {
      return {
        ok: false,
        reason: state.reason,
        message: state.reason === 'SOLD_OUT' ? '该菜品已售罄，不能继续加' : '该菜品已被商家下架，请移除后结算',
        lines: list
      }
    }
    if (found.qty >= cartUtil.MAX_QTY) {
      return { ok: false, reason: 'MAX_QTY', message: '单个菜品最多 ' + cartUtil.MAX_QTY + ' 份', lines: list }
    }
    cartUtil.setQty(key, Math.min(found.qty + step, cartUtil.MAX_QTY))
    return { ok: true, reason: '', message: '', lines: cartUtil.load(), removed: false }
  }
  const next = found.qty + step
  if (next <= 0) {
    cartUtil.remove(key)
    return { ok: true, reason: '', message: '', lines: cartUtil.load(), removed: true }
  }
  cartUtil.setQty(key, next)
  return { ok: true, reason: '', message: '', lines: cartUtil.load(), removed: false }
}

module.exports = { dishState, buildRows, summary, stepQty }
