/* 错误归一化与诊断信息组装（UMD，可在浏览器与单测中复用） */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory()
  } else {
    root.AdminDiagnostics = factory()
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function isPlainObject(value) {
    if (!value || typeof value !== 'object') return false
    var proto = Object.getPrototypeOf(value)
    return proto === Object.prototype || proto === null
  }

  /** 安全序列化：处理循环引用、Error、函数、超深对象，保证不抛异常 */
  function safeSerialize(value, options) {
    var opts = options || {}
    var maxDepth = typeof opts.maxDepth === 'number' ? opts.maxDepth : 4
    var seen = []

    function walk(node, depth) {
      if (node === undefined) return '[undefined]'
      if (node === null) return null
      var type = typeof node
      if (type === 'string' || type === 'number' || type === 'boolean') return node
      if (type === 'bigint') return String(node) + 'n'
      if (type === 'symbol') return String(node)
      if (type === 'function') return '[function ' + (node.name || 'anonymous') + ']'
      if (seen.indexOf(node) >= 0) return '[Circular]'
      if (depth <= 0) return '[MaxDepth]'
      seen.push(node)

      if (node instanceof Error) {
        var errOut = {
          __type: node.name || 'Error',
          message: node.message,
          stack: node.stack || ''
        }
        Object.keys(node).forEach(function (key) {
          errOut[key] = walk(node[key], depth - 1)
        })
        seen.pop()
        return errOut
      }
      if (node instanceof Date) {
        seen.pop()
        return '[Date ' + node.toISOString() + ']'
      }
      if (Array.isArray(node)) {
        var arr = node.slice(0, 50).map(function (item) {
          return walk(item, depth - 1)
        })
        seen.pop()
        return arr
      }
      if (isPlainObject(node)) {
        var out = {}
        Object.keys(node).forEach(function (key) {
          if (key === '__proto__' || key === 'constructor') return
          out[key] = walk(node[key], depth - 1)
        })
        seen.pop()
        return out
      }
      // 非普通对象（SDK 响应、Request、Response 等）：只取自有可枚举字段，避免巨型对象
      var loose = { __type: (node.constructor && node.constructor.name) || 'Object' }
      try {
        Object.keys(node).forEach(function (key) {
          if (key === '__proto__' || key === 'constructor') return
          loose[key] = walk(node[key], depth - 1)
        })
      } catch (e) {
        loose.__error = String(e && e.message)
      }
      seen.pop()
      return loose
    }

    try {
      return walk(value, maxDepth)
    } catch (e) {
      return '[Unserializable] ' + String(e && e.message)
    }
  }

  function requestUrlOf(err) {
    var e = err || {}
    if (e.url) return String(e.url)
    if (e.requestUrl) return String(e.requestUrl)
    if (e.config && e.config.url) return String(e.config.url)
    if (e.request && e.request.url) return String(e.request.url)
    if (e.response && e.response.url) return String(e.response.url)
    return ''
  }

  function httpStatusOf(err) {
    var e = err || {}
    return Number(e.status || e.statusCode || (e.response && e.response.status) || 0) || 0
  }

  /** 归一化错误：code / message / errMsg / errCode / requestId / status / url / fields 一个都不丢 */
  function describeError(err) {
    if (err === undefined || err === null) {
      return { type: 'none', code: '', message: '无错误对象', errMsg: '', errCode: '', requestId: '', status: 0, url: '', fields: null }
    }
    if (typeof err !== 'object') {
      return { type: typeof err, code: '', message: String(err), errMsg: '', errCode: '', requestId: '', status: 0, url: '', fields: String(err) }
    }
    var e = err
    return {
      type: (e.constructor && e.constructor.name) || 'Object',
      code: e.code || e.errCode || '',
      message: e.message || '',
      errMsg: e.errMsg || '',
      errCode: e.errCode || '',
      requestId: e.requestId || e.requestID || e.traceId || '',
      status: httpStatusOf(e),
      url: requestUrlOf(e),
      stack: e.stack || '',
      fields: safeSerialize(e)
    }
  }

  /** 可读错误串：绝不出现「未知错误」这种空信息 */
  function formatErrorText(err) {
    var d = describeError(err)
    if (d.type === 'none') return '无错误对象'
    var head = (d.code || 'ERR') + ' · ' + (d.message || d.errMsg || '（错误对象没有 message/errMsg）')
    var meta = []
    if (d.status) meta.push('HTTP ' + d.status)
    if (d.url) meta.push(d.url)
    if (d.requestId) meta.push('requestId=' + d.requestId)
    if (d.errCode && String(d.errCode) !== String(d.code)) meta.push('errCode=' + d.errCode)
    return head + (meta.length ? '\n' + meta.join(' | ') : '') + '\n原始对象：' + JSON.stringify(d.fields)
  }

  /** 组装「复制诊断信息」文本 */
  function buildDiagnostics(info) {
    var i = info || {}
    var anon = i.anon || {}
    var lines = []
    lines.push('===== 平台管理台诊断信息 =====')
    lines.push('时间：' + (i.time || new Date().toISOString()))
    lines.push('页面 origin：' + (i.origin || ''))
    lines.push('打开协议：' + (i.protocol || ''))
    lines.push('环境 ID：' + (i.envId || ''))
    lines.push('SDK 版本：' + (i.sdkVersion || '未检测到'))
    lines.push('SDK 加载：' + (i.sdkLoaded === false ? '失败' : '成功'))
    lines.push('匿名登录：' + (i.gatewayInjected ? '未使用（本地网关）' : (anon.ok ? '成功' : '失败')))
    if (!anon.ok && !i.gatewayInjected) {
      lines.push('匿名登录原始错误：')
      lines.push(formatErrorText(anon.error))
    }
    if (anon.status && !i.gatewayInjected) lines.push('匿名登录 HTTP：' + anon.status)
    if (anon.url && !i.gatewayInjected) lines.push('匿名登录请求 URL：' + anon.url)
    lines.push('连接方式：' + (i.connectionLabel || i.connectionMode || (i.httpMode ? 'HTTP 访问服务' : '小程序云调用（匿名登录）')))
    if (i.gatewayInjected) lines.push('网关配置：页面已注入（地址 ' + (i.httpEndpoint || '/api') + '，本机口令已注入）')
    lines.push('最近一次调用错误：')
    lines.push(i.lastError ? formatErrorText(i.lastError) : '无')
    var pageErrors = i.pageErrors || []
    lines.push('页面全局错误：')
    lines.push(pageErrors.length ? pageErrors.join('\n---\n') : '无')
    return lines.join('\n')
  }

  return {
    safeSerialize: safeSerialize,
    describeError: describeError,
    formatErrorText: formatErrorText,
    buildDiagnostics: buildDiagnostics,
    httpStatusOf: httpStatusOf,
    requestUrlOf: requestUrlOf
  }
})
