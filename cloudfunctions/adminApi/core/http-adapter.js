'use strict'

/**
 * HTTP 访问服务适配（纯函数，便于离线单测）。
 * 云函数收到的 HTTP event 形如：
 * { httpMethod, headers, queryStringParameters, body, isBase64Encoded, requestContext }
 */

function isHttpEvent(event) {
  if (!event) return false
  return Boolean(event.httpMethod || event.requestContext)
}

function headerValue(headers, name) {
  const source = headers || {}
  const target = String(name || '').toLowerCase()
  const key = Object.keys(source).filter((item) => item.toLowerCase() === target)[0]
  return key ? String(source[key] || '') : ''
}

function queryValue(query, name) {
  const source = query || {}
  const target = String(name || '').toLowerCase()
  const key = Object.keys(source).filter((item) => item.toLowerCase() === target)[0]
  return key ? String(source[key] || '') : ''
}

/**
 * token 顺序：header x-admin-token → query token → body.token
 * HTTP 模式不依赖 getWXContext()。
 */
function extractToken(event, body) {
  const fromHeader = headerValue(event && event.headers, 'x-admin-token')
  if (fromHeader) return { token: fromHeader, source: 'header' }
  const fromQuery = queryValue(event && event.queryStringParameters, 'token')
  if (fromQuery) return { token: fromQuery, source: 'query' }
  const fromBody = String((body && body.token) || (body && body.payload && body.payload.token) || '')
  if (fromBody) return { token: fromBody, source: 'body' }
  return { token: '', source: 'none' }
}

function corsHeaders(event, allowedOrigins) {
  const requestOrigin = headerValue(event && event.headers, 'origin')
  let allowOrigin = '*'
  if (Array.isArray(allowedOrigins) && allowedOrigins.length) {
    allowOrigin = allowedOrigins.indexOf(requestOrigin) >= 0 ? requestOrigin : allowedOrigins[0]
  } else if (requestOrigin) {
    allowOrigin = requestOrigin
  }
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'content-type,x-admin-token',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
    'Content-Type': 'application/json; charset=utf-8'
  }
}

function parseHttpBody(event) {
  const raw = event && event.body
  if (!raw) return { ok: true, value: {} }
  let text = raw
  if (event && event.isBase64Encoded) {
    try {
      text = Buffer.from(String(raw), 'base64').toString('utf8')
    } catch (err) {
      return { ok: false, error: 'BASE64_DECODE_FAILED' }
    }
  }
  if (typeof text !== 'string') {
    return text && typeof text === 'object' ? { ok: true, value: text } : { ok: false, error: 'BAD_JSON' }
  }
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, error: 'NOT_OBJECT' }
    }
    return { ok: true, value: value }
  } catch (err) {
    return { ok: false, error: 'BAD_JSON' }
  }
}

module.exports = { isHttpEvent, headerValue, queryValue, extractToken, corsHeaders, parseHttpBody }
