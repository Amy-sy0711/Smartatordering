'use strict'

/** 展示层兜底：任何 undefined / null / NaN 都不直接上屏 */
function safeText(value, fallback) {
  const fb = fallback === undefined ? '' : fallback
  if (value === null || value === undefined) return fb
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : fb
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed ? value : fb
  }
  return fb
}

function safeNumber(value, fallback) {
  const fb = fallback === undefined ? 0 : fallback
  if (value === null || value === undefined || value === '') return fb
  if (typeof value === 'boolean') return fb
  const num = Number(value)
  return Number.isFinite(num) ? num : fb
}

function safeInt(value, fallback) {
  const num = safeNumber(value, fallback)
  return Math.floor(num)
}

function safeArray(value) {
  return Array.isArray(value) ? value : []
}

module.exports = { safeText, safeNumber, safeInt, safeArray }
