'use strict'

/**
 * 取餐码（4 位，每日每商家从 0001 自增）
 *
 * - 计数器文档 `_id = pickup_seq_<merchantId>_<yyyyMMdd>`，用 `_.inc(1)` 原子自增，禁止先读再写；
 * - 首次创建并发：add 冲突说明已被别人创建，回读后继续自增，最多 3 轮；
 * - 超过 9999 继续自增并按 5 位显示（10000），不回绕、不重号，并返回 warning；
 * - 同一订单重复出餐不会重复占号（调用方先判断 order.pickupCode）。
 */

const OVER_WARNING = '当日取餐码已超过 9999，按 5 位显示'

/** 序号 → 取餐码文本：0001…9999，之后 10000… */
function formatPickupCode(seq) {
  const n = Math.max(Number(seq) || 0, 0)
  if (!n) return ''
  return n <= 9999 ? String(n).padStart(4, '0') : String(n)
}

function counterId(merchantId, dateKey) {
  return 'pickup_seq_' + String(merchantId || '') + '_' + String(dateKey || '')
}

function result(seq, extra) {
  const n = Math.max(Number(seq) || 0, 0)
  const out = { seq: n, code: formatPickupCode(n), warning: n > 9999 ? OVER_WARNING : '' }
  return extra ? Object.assign(out, extra) : out
}

/**
 * 原子分配下一个取餐码。
 * store 需实现：inc(id)（返回 {updated}）、add(id, seq)、read(id)（返回 {seq} 或 null）
 */
async function nextPickupCode(store, merchantId, dateKey, options) {
  const id = counterId(merchantId, dateKey)
  const maxAttempts = (options && options.maxAttempts) || 3

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const inc = await store.inc(id)
    if (inc && inc.updated) {
      // 优先用自增返回的新值（事务内读改写，避免并发读到别人的新值）
      let seq = Number(inc.seq) || 0
      if (!seq) {
        const doc = await store.read(id)
        seq = Number(doc && doc.seq) || 0
      }
      if (seq > 0) return result(seq)
      continue // 自增成功但读不到（极端情况），重试
    }
    // 计数器文档还不存在：尝试创建，冲突说明并发创建，回到自增
    try {
      await store.add(id, 1)
      return result(1)
    } catch (err) {
      // 忽略冲突，继续自增
    }
  }

  // 兜底：最后一轮只做自增 + 回读，仍失败说明存储异常，交给调用方处理
  const last = await store.inc(id)
  const doc = last && last.updated ? await store.read(id) : null
  return result((doc && Number(doc.seq)) || 1)
}

/** 云开发数据库适配：counters 集合 + 事务内 `_.inc` 原子自增并返回新序号 */
function dbStore(db, _, collectionName) {
  const col = collectionName || 'counters'
  const now = () => new Date()
  return {
    async inc(id) {
      // 事务保证「读 + 自增」在同一原子操作里，避免并发读到别人的新值导致重号
      return db.runTransaction(async (transaction) => {
        const ref = transaction.collection(col).doc(id)
        let doc = null
        try {
          const res = await ref.get()
          doc = (res && res.data) || null
        } catch (err) {
          doc = null
        }
        if (!doc) return { updated: 0 }
        const nextSeq = (Number(doc.seq) || 0) + 1
        await ref.update({ data: { seq: _.inc(1), updatedAt: now() } })
        return { updated: 1, seq: nextSeq }
      })
    },
    async add(id, seq) {
      await db.collection(col).add({ data: { _id: id, seq: seq || 1, createdAt: now(), updatedAt: now() } })
    },
    async read(id) {
      try {
        const res = await db.collection(col).doc(id).get()
        return (res && res.data) || null
      } catch (err) {
        return null
      }
    }
  }
}

module.exports = { formatPickupCode, counterId, nextPickupCode, dbStore, OVER_WARNING }
