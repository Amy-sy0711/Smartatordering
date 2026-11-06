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

/** 读取任意历史形态的时段数组，统一成 { id, label, limit } */
function readSlots(rawSlots, defaultLimit) {
  const fallbackLimit = Number.isInteger(defaultLimit) && defaultLimit > 0 ? defaultLimit : DEFAULT_SLOT_LIMIT
  if (!Array.isArray(rawSlots)) return []
  return rawSlots.map((raw, index) => {
    if (typeof raw === 'string') {
      return { id: 's' + (index + 1), label: raw.trim() || '取餐时段', limit: fallbackLimit }
    }
    const src = raw || {}
    const rawLimit = Number(src.limit)
    return {
      id: src.id ? String(src.id) : 's' + (index + 1),
      label: typeof src.label === 'string' && src.label.trim() ? src.label : '取餐时段',
      limit: Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : fallbackLimit
    }
  })
}

function findSlot(menu, slotId) {
  const slots = readSlots(menu && menu.slots)
  const target = String(slotId === null || slotId === undefined ? '' : slotId)
  const found = slots.filter((s) => s.id === target)[0]
  if (!found) fail('SLOT_NOT_FOUND', '取餐时段不存在，请刷新后重新选择')
  return found
}

const DEFAULT_SLOT_LIMIT = 20

/**
 * 兼容历史数据：旧版菜单的 slots 可能存成字符串（如 "11:30-12:00"）。
 * 任何缺失字段都兜底，保证页面永远拿得到 label / left，不会出现「剩undefined」。
 */
function slotAvailability(slot, used) {
  const src = typeof slot === 'string' ? { label: slot } : (slot || {})
  const rawLimit = Number(src.limit)
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : DEFAULT_SLOT_LIMIT
  const usedCount = Number.isInteger(used) && used >= 0 ? used : 0
  const label = typeof src.label === 'string' && src.label.trim() ? src.label : '取餐时段'
  return {
    id: src.id ? String(src.id) : 's1',
    label,
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

module.exports = { normalizeSlots, readSlots, findSlot, slotAvailability, checkCapacity, MAX_SLOT_LIMIT, MAX_SLOTS }
