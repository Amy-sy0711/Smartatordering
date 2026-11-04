'use strict'

const { fail } = require('./errors')

const MAX_SLOT_LIMIT = 500
const MAX_SLOTS = 8

/**
 * 标准化取餐时段（商家发布菜单 / 复制历史菜单时调用）。
 * id 采用 s1..sN 稳定编号：同一天内重新发布不会重置已占用名额。
 */
function normalizeSlots(rawSlots, defaultLimit) {
  const fallbackLimit = Number.isInteger(defaultLimit) ? defaultLimit : 20
  if (!Array.isArray(rawSlots) || rawSlots.length === 0) fail('SLOT_REQUIRED', '至少需要配置一个取餐时段')
  if (rawSlots.length > MAX_SLOTS) fail('SLOT_TOO_MANY', `最多支持 ${MAX_SLOTS} 个取餐时段`)

  const seenLabel = {}
  const seenId = {}
  const result = []

  rawSlots.forEach((raw, index) => {
    const label = raw && typeof raw.label === 'string' ? raw.label.trim() : ''
    if (!label) fail('SLOT_INVALID', '取餐时段名称不能为空')
    if (label.length > 20) fail('SLOT_INVALID', '取餐时段名称最长 20 个字符')
    if (seenLabel[label]) fail('SLOT_INVALID', `取餐时段「${label}」重复`)
    seenLabel[label] = true

    let limit = raw.limit
    if (limit === undefined || limit === null || limit === '') limit = fallbackLimit
    limit = Number(limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SLOT_LIMIT) {
      fail('SLOT_LIMIT_INVALID', `取餐时段「${label}」限量必须是 1-${MAX_SLOT_LIMIT} 的整数`)
    }

    const id = raw.id && !seenId[raw.id] ? String(raw.id) : 's' + (index + 1)
    seenId[id] = true
    result.push({ id, label, limit })
  })

  return result
}

function findSlot(menu, slotId) {
  const slots = (menu && menu.slots) || []
  const target = String(slotId === null || slotId === undefined ? '' : slotId)
  const found = slots.filter((s) => s.id === target)[0]
  if (!found) fail('SLOT_NOT_FOUND', '取餐时段不存在，请刷新后重新选择')
  return found
}

function slotAvailability(slot, used) {
  const limit = Number(slot.limit) || 0
  const usedCount = Number.isInteger(used) && used >= 0 ? used : 0
  return {
    id: slot.id,
    label: slot.label,
    limit,
    used: usedCount,
    left: Math.max(limit - usedCount, 0),
    full: usedCount >= limit
  }
}

/** 纯函数版容量校验（DB 原子自增前的快速判断） */
function checkCapacity(used, limit) {
  if (!Number.isInteger(limit) || limit < 1) fail('SLOT_LIMIT_INVALID', '时段限量配置不合法')
  if (!Number.isInteger(used) || used < 0) fail('SLOT_USED_INVALID', '时段占用数不合法')
  if (used >= limit) fail('SLOT_FULL', '该取餐时段已满，请选择其他时段')
  return used + 1
}

module.exports = { normalizeSlots, findSlot, slotAvailability, checkCapacity, MAX_SLOT_LIMIT, MAX_SLOTS }
