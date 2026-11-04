'use strict'

/**
 * 时间工具：所有「自然日」以 Asia/Shanghai 为准。
 * 中国无夏令时，固定 +8 小时偏移即可安全换算，不依赖运行环境 TZ。
 */
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function normalize(input) {
  if (input === undefined || input === null) return new Date()
  if (input instanceof Date) return input
  if (typeof input === 'number') return new Date(input)
  const parsed = new Date(input)
  if (isNaN(parsed.getTime())) {
    throw new Error('无效的时间输入: ' + String(input))
  }
  return parsed
}

/** 'YYYY-MM-DD'（上海时区） */
function shanghaiDateKey(input) {
  const shifted = new Date(normalize(input).getTime() + SHANGHAI_OFFSET_MS)
  return shifted.toISOString().slice(0, 10)
}

/** 'YYYYMMDD'（上海时区），用于订单号/菜单 ID */
function shanghaiCompact(input) {
  return shanghaiDateKey(input).replace(/-/g, '')
}

/** '2026-11-04 周三' */
function shanghaiDateLabel(dateKey) {
  const key = String(dateKey || shanghaiDateKey())
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key)
  if (!m) return key
  const epoch = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const weekday = WEEKDAYS[new Date(epoch).getUTCDay()]
  return key + ' ' + weekday
}

/** '11/04 12:30'（上海时区，列表展示用） */
function shanghaiShortTime(input) {
  if (!input) return ''
  const iso = new Date(normalize(input).getTime() + SHANGHAI_OFFSET_MS).toISOString()
  return iso.slice(5, 10).replace('-', '/') + ' ' + iso.slice(11, 16)
}

/** '2026-11-04 12:30'（上海时区，详情展示用） */
function shanghaiDateTime(input) {
  if (!input) return ''
  const iso = new Date(normalize(input).getTime() + SHANGHAI_OFFSET_MS).toISOString()
  return iso.slice(0, 10) + ' ' + iso.slice(11, 16)
}

/** 自然日 [start, end) 的毫秒区间 */
function dayRange(dateKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey))
  if (!m) throw new Error('无效的日期: ' + String(dateKey))
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - SHANGHAI_OFFSET_MS
  return { start, end: start + 24 * 60 * 60 * 1000 }
}

module.exports = {
  SHANGHAI_OFFSET_MS,
  shanghaiDateKey,
  shanghaiCompact,
  shanghaiDateLabel,
  shanghaiShortTime,
  shanghaiDateTime,
  dayRange
}
