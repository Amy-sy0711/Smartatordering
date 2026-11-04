'use strict'

/** 读取单文档，不存在返回 null（云数据库在文档缺失时 get 会抛错） */
async function getDocOrNull(db, collectionName, id) {
  try {
    const res = await db.collection(collectionName).doc(id).get()
    return (res && res.data) || null
  } catch (err) {
    return null
  }
}

/**
 * 分页取完整个结果集（云函数单次 get 有上限）。
 * @param {Function} queryFactory 每次返回一个新的 Query，例如 () => db.collection('orders').where({...}).orderBy('createdAt','asc')
 */
async function fetchAll(queryFactory, options) {
  const opts = options || {}
  const pageSize = opts.pageSize || 100
  const max = opts.max || 2000
  const list = []
  let skip = 0
  while (skip < max) {
    const res = await queryFactory().skip(skip).limit(pageSize).get()
    const data = (res && res.data) || []
    for (const item of data) list.push(item)
    if (data.length < pageSize) break
    skip += pageSize
  }
  return list
}

/** 文档是否「不存在」错误 */
function isDocNotExist(err) {
  const message = (err && (err.errMsg || err.message)) || ''
  return /not exist|does not exist|not found|cannot find document/i.test(message)
}

module.exports = { getDocOrNull, fetchAll, isDocNotExist }
