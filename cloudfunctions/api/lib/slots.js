'use strict'

const { COLLECTIONS: COL } = require('../core/collections')
const { fail } = require('../core/errors')
const { getDocOrNull } = require('./db')

function counterDocId(menuId, slotId) {
  return menuId + '__' + slotId
}

/** 确保时段计数器存在（发布菜单时调用；已存在只同步 limit，不重置 used） */
async function ensureSlotCounter(db, menuId, dateKey, slot) {
  const id = counterDocId(menuId, slot.id)
  const existing = await getDocOrNull(db, COL.SLOT_COUNTERS, id)
  if (existing) {
    if (existing.limit !== slot.limit) {
      await db.collection(COL.SLOT_COUNTERS).doc(id).update({ data: { limit: slot.limit, updatedAt: new Date() } })
    }
    return existing
  }
  try {
    await db.collection(COL.SLOT_COUNTERS).doc(id).set({
      data: {
        menuId,
        slotId: slot.id,
        date: dateKey,
        label: slot.label,
        limit: slot.limit,
        used: 0,
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })
  } catch (err) {
    // 并发创建：忽略重复
  }
  return getDocOrNull(db, COL.SLOT_COUNTERS, id)
}

/**
 * 占用一个时段名额。
 * 依赖「单文档带条件更新」的原子性：只有 used < limit 时才会 +1，
 * 并发下不会超卖（等价于 CAS 自增）。
 */
async function reserveSlot(db, _, menuId, dateKey, slot) {
  await ensureSlotCounter(db, menuId, dateKey, slot)
  const id = counterDocId(menuId, slot.id)
  const res = await db.collection(COL.SLOT_COUNTERS)
    .where({ _id: id, used: _.lt(slot.limit) })
    .update({ data: { used: _.inc(1), updatedAt: new Date() } })
  const updated = res && res.stats ? res.stats.updated : 0
  if (!updated) fail('SLOT_FULL', `取餐时段「${slot.label}」已满，请选择其他时段`)
  return true
}

/** 释放一个时段名额（下单失败或订单取消时回滚） */
async function releaseSlot(db, _, menuId, slotId) {
  const id = counterDocId(menuId, slotId)
  await db.collection(COL.SLOT_COUNTERS)
    .where({ _id: id, used: _.gt(0) })
    .update({ data: { used: _.inc(-1), updatedAt: new Date() } })
}

async function getSlotUsage(db, _, menuId, slotIds) {
  if (!slotIds.length) return {}
  const res = await db.collection(COL.SLOT_COUNTERS)
    .where({ _id: _.in(slotIds.map((id) => counterDocId(menuId, id))) })
    .get()
  const usage = {}
  for (const doc of res.data || []) usage[doc.slotId] = doc.used || 0
  return usage
}

module.exports = { counterDocId, ensureSlotCounter, reserveSlot, releaseSlot, getSlotUsage }
