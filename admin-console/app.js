(function () {
  'use strict'

  const ENV_KEY = 'ordering_admin_env'
  const TOKEN_KEY = 'ordering_admin_token'
  const DEFAULT_ENV = 'ordering-d0gyct6z1ff2afebd'

  let cloudApp = null
  let token = sessionStorage.getItem(TOKEN_KEY) || ''
  let adminName = ''
  let merchantsCache = []
  let anonState = { ok: false, error: '尚未初始化' }
  let lastErrorText = ''
  let loginState = null

  function makeErr(code, message, hint) {
    const err = new Error(String(message || '操作失败'))
    err.code = code || 'UNKNOWN'
    err.hint = hint || ''
    return err
  }

  function reportPageError(text) {
    if (typeof window.__reportPageError === 'function') window.__reportPageError(text)
  }

  function showBanner(text) {
    const el = $('page-banner')
    if (!el) return
    el.textContent = text
    el.classList.remove('hidden')
  }

  function $(id) {
    return document.getElementById(id)
  }

  function esc(value) {
    return String(value === undefined || value === null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function fmtTime(value) {
    if (!value) return '—'
    const date = new Date(value)
    if (isNaN(date.getTime())) return String(value)
    return date.toLocaleString('zh-CN')
  }

  function setConn(text) {
    const el = $('conn-status')
    if (el) el.textContent = text
  }

  /** 云开发 SDK 抛出的不一定是 Error，errMsg / message 都要兼容 */
  function errText(err) {
    if (!err) return '未知错误'
    if (typeof err === 'string') return err
    return String(err.errMsg || err.errMessage || err.message || '未知错误')
  }

  function httpStatusOf(err) {
    const e = err || {}
    return Number(e.status || e.statusCode || (e.response && e.response.status) || 0) || 0
  }

  function requestUrlOf(err) {
    const e = err || {}
    if (e.url) return String(e.url)
    if (e.requestUrl) return String(e.requestUrl)
    if (e.config && e.config.url) return String(e.config.url)
    if (e.request && e.request.url) return String(e.request.url)
    if (e.response && e.response.url) return String(e.response.url)
    return ''
  }

  /** 匿名登录失败的完整现场：code / HTTP / errMsg / 请求 URL，一个都不吞 */
  function anonErrorDetail(err) {
    const parts = []
    if (err && err.code) parts.push('code=' + err.code)
    const status = httpStatusOf(err)
    if (status) parts.push('HTTP=' + status)
    parts.push('errMsg=' + errText(err))
    const url = requestUrlOf(err)
    if (url) parts.push('URL=' + url)
    return parts.join(' | ')
  }

  function anonHint(err) {
    const status = httpStatusOf(err)
    if (status === 400) {
      return '云开发返回 400：请检查「Web 安全域名」是否包含当前域名（只填域名，不带 https:// 和路径），以及是否已开启匿名登录。'
    }
    if (status === 403) {
      return '云开发返回 403：当前域名未被允许，请把当前域名加入「Web 安全域名」后刷新页面。'
    }
    return '匿名登录失败：请确认已开启匿名登录，且当前域名已加入「Web 安全域名」。'
  }

  async function ensureApp() {
    if (cloudApp) return cloudApp
    const env = ($('env-id').value || '').trim() || DEFAULT_ENV
    localStorage.setItem(ENV_KEY, env)
    if (window.__SDK_LOAD_FAILED || typeof cloudbase === 'undefined') {
      showBanner('SDK 加载失败：请确认 vendor/cloudbase.full.js 已随页面一起上传且可访问，或改用单文件版 admin-console-standalone.html。')
      throw makeErr(
        'SDK_LOAD_FAILED',
        'CloudBase SDK 未加载（window.cloudbase is not defined）',
        '把 deploy/admin-console/vendor/cloudbase.full.js 上传到站点同目录；或直接使用单文件版（SDK 已内联）。这不是 400 白名单问题。'
      )
    }
    cloudApp = cloudbase.init({ env })
    // CloudBase JS SDK 2.x 标准匿名登录：先 auth，再 anonymousAuthProvider().signIn()
    const auth = cloudApp.auth({ persistence: 'local' })
    try {
      if (auth && typeof auth.anonymousAuthProvider === 'function') {
        await auth.anonymousAuthProvider().signIn()
      } else if (typeof auth.signInAnonymously === 'function') {
        // 兼容旧版 SDK
        await auth.signInAnonymously()
      } else if (typeof auth.anonymousAuth === 'function') {
        await auth.anonymousAuth()
      } else {
        throw makeErr('ANONYMOUS_REQUIRED', '当前 CloudBase SDK 不支持匿名登录 API', '请使用 deploy 目录里的 2.17.5 版本 SDK。')
      }
      if (auth && typeof auth.getLoginState === 'function') {
        const state = await auth.getLoginState()
        if (!state) throw makeErr('ANONYMOUS_REQUIRED', '匿名登录后未取得登录态')
      }
      anonState = { ok: true, error: '' }
    } catch (err) {
      // 不吞：保留原始 errMsg / HTTP / URL，并阻断后续 callFunction（匿名态没拿到就不该继续调）
      const detail = anonErrorDetail(err)
      const status = httpStatusOf(err)
      anonState = { ok: false, error: detail, status: status, url: requestUrlOf(err) }
      cloudApp = null
      showBanner('匿名登录失败（' + (status ? 'HTTP ' + status : '无状态码') + '）：请检查 Web 安全域名与匿名登录开关；详情见下方错误信息。')
      reportPageError('匿名登录失败：' + detail)
      throw makeErr(status === 400 ? 'ANONYMOUS_AUTH_400' : 'ANONYMOUS_REQUIRED', detail, anonHint(err))
    }
    setConn('已连接 ' + env)
    return cloudApp
  }

  async function callFunction(name, action, payload, withToken) {
    await ensureApp()
    const body = { action, payload: Object.assign({}, payload || {}) }
    if (withToken !== false) body.payload.token = token
    let res = null
    try {
      res = await cloudApp.callFunction({ name, data: body })
    } catch (err) {
      const e = new Error(errText(err) || '云函数调用失败')
      e.code = 'CALL_FUNCTION_FAILED'
      e.hint = '请确认：1) 云函数 ' + name + ' 已部署到当前环境；2) 环境 ID 正确；3) 本页面域名已加入云开发「Web 安全域名」并已开启匿名登录。'
      throw e
    }
    const result = (res && res.result) || {}
    if (result.code !== 0) {
      const err = new Error(result.message || ('接口失败：' + result.code))
      err.code = result.code || 'UNKNOWN_RESULT'
      err.hint = result.hint || ''
      throw err
    }
    return result.data
  }

  /* ------------------------------ 登录 / 会话 ------------------------------ */

  function clearLoginError() {
    const box = $('login-error-box')
    if (box) box.classList.add('hidden')
    lastErrorText = ''
  }

  /** 原样展示 code + message + hint，并保留可复制的纯文本 */
  function showLoginError(err) {
    const code = String((err && err.code) || 'UNKNOWN')
    const message = String((err && err.message) || '登录失败')
    const hint = String((err && err.hint) || '')
    lastErrorText = code + ': ' + message + (hint ? '\n修法：' + hint : '')
    $('login-error').textContent = code + ' · ' + message
    const hintEl = $('login-error-hint')
    hintEl.textContent = hint
    hintEl.classList.toggle('hidden', !hint)
    $('login-error-box').classList.remove('hidden')
    // 匿名登录没成功时，登录错误里补上客户端侧的真实原因
    if (!anonState.ok && anonState.error) {
      $('login-error-hint').textContent = (hint ? hint + '\n' : '') + '客户端匿名登录失败：' + anonState.error
      lastErrorText += '\n客户端匿名登录失败：' + anonState.error
    }
  }

  function copyText(text) {
    if (!text) return Promise.resolve(false)
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(() => true).catch(() => false)
    }
    try {
      const area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const okCopy = document.execCommand('copy')
      document.body.removeChild(area)
      return Promise.resolve(okCopy)
    } catch (err) {
      return Promise.resolve(false)
    }
  }

  async function copyLoginError() {
    const okCopy = await copyText(lastErrorText)
    const btn = $('btn-copy-error')
    if (!btn) return
    const old = btn.textContent
    btn.textContent = okCopy ? '已复制' : '复制失败，请手动选中'
    setTimeout(() => { btn.textContent = old }, 1800)
  }

  function renderLoginButton(state) {
    const btn = $('btn-login')
    const spinner = $('login-spinner')
    const text = $('login-btn-text')
    if (!btn) return
    const loading = state === 'loading'
    btn.disabled = loading
    btn.classList.toggle('is-loading', loading)
    if (spinner) spinner.classList.toggle('hidden', !loading)
    if (text) text.textContent = loading ? '登录中…' : '登录'
  }

  async function login(event) {
    if (event) event.preventDefault()
    if (loginState && !loginState.start()) return
    clearLoginError()
    const username = $('login-username').value.trim()
    const password = $('login-password').value
    try {
      if (!username || !password) {
        throw makeErr('PASSWORD_REQUIRED', '请输入用户名和密码', '首次登录的密码就是 ADMIN_BOOTSTRAP_PASSWORD 的值。')
      }
      const data = await callFunction('adminAuth', 'login', { username: username, password: password }, false)
      token = data.token
      adminName = (data.admin && data.admin.username) || username
      sessionStorage.setItem(TOKEN_KEY, token)
      if (loginState) loginState.succeed()
      showApp()
      await refreshAll()
    } catch (err) {
      showLoginError(err)
      if (loginState) loginState.fail()
    }
  }

  function showApp() {
    $('login-panel').classList.add('hidden')
    $('app-panel').classList.remove('hidden')
    $('admin-name').textContent = adminName ? '当前管理员：' + adminName : ''
  }

  function logout() {
    token = ''
    adminName = ''
    sessionStorage.removeItem(TOKEN_KEY)
    $('app-panel').classList.add('hidden')
    $('login-panel').classList.remove('hidden')
    $('login-password').value = ''
  }

  function handleAuthError(err) {
    const code = err && err.code
    if (code === 'UNAUTHORIZED' || code === 'TOKEN_EXPIRED' || code === 'TOKEN_FORGED' || code === 'TOKEN_INVALID') {
      logout()
      showLoginError(err)
      return true
    }
    return false
  }

  /* ------------------------------ 首屏自检 ------------------------------ */

  /** 登录前 preflight：直接打一次环境域名，把 HTTP 状态码摊在页面上 */
  async function runPreflight(env) {
    const url = 'https://' + env + '.tcloudbaseapp.com/__auth'
    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), 8000) : null
    try {
      const res = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined
      })
      if (timer) clearTimeout(timer)
      return { url: url, status: res.status, ok: res.status === 200, error: '' }
    } catch (err) {
      if (timer) clearTimeout(timer)
      return { url: url, status: 0, ok: false, error: errText(err) }
    }
  }

  function preflightHint(pre) {
    if (pre.status === 400) {
      return '云开发返回 400：请检查「Web 安全域名」是否包含 ' + location.origin.replace(/^https?:\/\//, '') + '（只填域名，不带路径、不带协议），并确认已开启匿名登录。'
    }
    if (pre.status === 403) {
      return '云开发返回 403：当前域名未加入 Web 安全域名，请把 ' + location.origin.replace(/^https?:\/\//, '') + ' 加进去后刷新。'
    }
    if (pre.status === 0) {
      return '探测被浏览器拦截（CORS/网络）：多数也是域名未加白名单；请同时确认页面通过 http(s) 打开而不是 file://。'
    }
    return '返回 HTTP ' + pre.status + '，无法据此单独判断；请以登录时的实际错误为准。'
  }

  function preflightRow(pre) {
    const hardFail = pre.status === 400 || pre.status === 403 || pre.status === 0
    const label = pre.status ? 'HTTP ' + pre.status : '无响应'
    return (
      '<div class="check-item' + (hardFail ? ' bad' : '') + '">' +
      '<div class="check-line">' +
      '<span class="check-flag">' + (hardFail ? '✕' : '✓') + '</span>' +
      '<span class="check-label">环境域名探测</span>' +
      '<span class="check-detail">' + esc(label) + ' · ' + esc(pre.url) + '</span>' +
      '</div>' +
      (pre.ok ? '' : '<div class="check-hint">' + esc(preflightHint(pre)) + (pre.error ? '（' + esc(pre.error) + '）' : '') + '</div>') +
      '</div>'
    )
  }

  async function runPrecheck() {
    const box = $('precheck-list')
    if (!box) return
    box.innerHTML = '<p class="muted">检测中…</p>'
    const env = ($('env-id').value || '').trim() || DEFAULT_ENV
    const pre = await runPreflight(env)
    const preflightEl = $('preflight-text')
    if (preflightEl) {
      preflightEl.textContent =
        '环境域名探测：' + (pre.status ? 'HTTP ' + pre.status : '无响应') + ' · ' + pre.url +
        (pre.status === 400 ? ' —— 400 通常是 Web 安全域名未包含当前域名或未开启匿名登录' : '')
    }
    try {
      const data = await callFunction('adminAuth', 'precheck', {}, false)
      renderPrecheck(data, pre)
    } catch (err) {
      // 匿名登录失败属于「服务端没放行」，必须立刻显示在登录错误区，而不是等用户点登录
      if (err && (err.code === 'ANONYMOUS_AUTH_400' || err.code === 'ANONYMOUS_REQUIRED' || err.code === 'SDK_LOAD_FAILED')) {
        showLoginError(err)
      }
      box.innerHTML =
        preflightRow(pre) +
        '<div class="check-item bad">' +
        '<div class="check-line"><span class="check-flag">✕</span><span class="check-label">自检接口不可用</span>' +
        '<span class="check-detail">' + esc(String((err && err.code) || '')) + ' ' + esc(String((err && err.message) || '')) + '</span></div>' +
        (err && err.hint ? '<div class="check-hint">' + esc(err.hint) + '</div>' : '') +
        '</div>'
      setConn('自检失败')
    }
  }

  function renderPrecheck(data, pre) {
    const box = $('precheck-list')
    const checks = (data && data.checks) || []
    if (!checks.length) {
      box.innerHTML = preflightRow(pre) + '<p class="muted">自检未返回结果</p>'
      setConn('自检无结果')
      return
    }
    box.innerHTML =
      preflightRow(pre) +
      checks
        .map((item) => {
          const bad = !item.ok
          return (
            '<div class="check-item' + (bad ? ' bad' : '') + '">' +
            '<div class="check-line">' +
            '<span class="check-flag">' + (bad ? '✕' : '✓') + '</span>' +
            '<span class="check-label">' + esc(item.label) + '</span>' +
            '<span class="check-detail">' + esc(item.detail) + '</span>' +
            '</div>' +
            (bad && item.hint ? '<div class="check-hint">' + esc(item.hint) + '</div>' : '') +
            '</div>'
          )
        })
        .join('')

    const failed = checks.filter((item) => !item.ok)
    if (!failed.length) {
      setConn('自检通过')
      return
    }
    setConn('自检发现 ' + failed.length + ' 项待处理')
  }

  /* ------------------------------ 商家列表 ------------------------------ */

  async function loadMerchants() {
    const tbody = $('merchant-tbody')
    tbody.innerHTML = '<tr><td colspan="7" class="muted">加载中…</td></tr>'
    try {
      const data = await callFunction('adminApi', 'merchant.list', {
        search: $('merchant-search').value.trim(),
        status: $('merchant-status-filter').value
      })
      merchantsCache = data.list || []
      renderMerchants()
    } catch (err) {
      if (handleAuthError(err)) return
      tbody.innerHTML = '<tr><td colspan="7" class="error-text">' + esc(err.message) + '</td></tr>'
    }
  }

  function statusBadge(status) {
    if (status === 'disabled') return '<span class="badge off">已停用</span>'
    return '<span class="badge ok">启用</span>'
  }

  function renderMerchants() {
    const tbody = $('merchant-tbody')
    if (!merchantsCache.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">暂无商家，点击「新建商家」创建。</td></tr>'
      return
    }
    tbody.innerHTML = merchantsCache
      .map((item) => {
        return (
          '<tr>' +
          '<td class="mono">' + esc(item.merchantId) + '</td>' +
          '<td>' + esc(item.name) + '</td>' +
          '<td>' + statusBadge(item.status) + '</td>' +
          '<td>' + esc(item.staffCount) + '</td>' +
          '<td>' + esc(item.todayOrderCount) + '</td>' +
          '<td>' + esc(item.plan || 'basic') + '<br><span class="muted">' + esc(item.expiresAt || '未设置') + '</span></td>' +
          '<td class="row">' +
          '<button class="btn small" data-act="edit" data-id="' + esc(item.merchantId) + '">编辑</button>' +
          '<button class="btn small" data-act="staff" data-id="' + esc(item.merchantId) + '">员工</button>' +
          '<button class="btn small" data-act="toggle" data-id="' + esc(item.merchantId) + '">' + (item.status === 'disabled' ? '启用' : '停用') + '</button>' +
          '<button class="btn small" data-act="resetpw" data-id="' + esc(item.merchantId) + '">重置密码</button>' +
          '</td>' +
          '</tr>'
        )
      })
      .join('')

    tbody.querySelectorAll('button[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const merchantId = btn.getAttribute('data-id')
        const act = btn.getAttribute('data-act')
        if (act === 'edit') openEditMerchant(merchantId)
        else if (act === 'staff') openStaff(merchantId)
        else if (act === 'toggle') toggleMerchant(merchantId)
        else if (act === 'resetpw') resetPassword(merchantId)
      })
    })
  }

  function findMerchant(merchantId) {
    return merchantsCache.filter((item) => item.merchantId === merchantId)[0] || null
  }

  /* ------------------------------ 弹窗 ------------------------------ */

  function openModal(title, bodyHtml) {
    $('modal-title').textContent = title
    $('modal-body').innerHTML = bodyHtml
    $('modal-foot').innerHTML = ''
    $('modal').classList.remove('hidden')
    return $('modal-body')
  }

  function closeModal() {
    $('modal').classList.add('hidden')
  }

  function modalButton(label, primary, onClick) {
    const btn = document.createElement('button')
    btn.className = 'btn' + (primary ? ' primary' : '')
    btn.textContent = label
    btn.addEventListener('click', onClick)
    $('modal-foot').appendChild(btn)
    return btn
  }

  function openCreateMerchant() {
    openModal(
      '新建商家',
      '<label>商家名称（必填）<input id="m-name" maxlength="20" /></label>' +
        '<label>商家 ID（可留空自动生成，仅字母数字下划线）<input id="m-id" placeholder="merchant_002" /></label>' +
        '<label>联系人 / 备注<input id="m-contact" maxlength="100" /></label>' +
        '<label>套餐（占位）<input id="m-plan" value="basic" /></label>' +
        '<label>有效期（占位）<input id="m-expires" placeholder="如 2027-12-31" /></label>'
    )
    modalButton('取消', false, closeModal)
    modalButton('创建', true, createMerchant)
  }

  async function createMerchant() {
    const payload = {
      name: $('m-name').value.trim(),
      merchantId: $('m-id').value.trim(),
      contact: $('m-contact').value.trim(),
      plan: $('m-plan').value.trim() || 'basic',
      expiresAt: $('m-expires').value.trim() || null
    }
    if (!payload.name) {
      alert('请填写商家名称')
      return
    }
    try {
      const data = await callFunction('adminApi', 'merchant.create', payload)
      await loadMerchants()
      openModal(
        '商家已创建（初始密码只显示这一次）',
        '<p>商家 ID：<code>' + esc(data.merchantId) + '</code></p>' +
          '<p>商家后台登录账号：<code>' + esc(data.loginUsername) + '</code></p>' +
          '<div class="secret-box">初始密码：<strong>' + esc(data.initialPassword) + '</strong><br>请线下交付给商家；关闭后不再显示，可在列表点「重置密码」重新生成。</div>'
      )
      modalButton('我已记录', true, closeModal)
    } catch (err) {
      if (handleAuthError(err)) return
      alert(err.message)
    }
  }

  function openEditMerchant(merchantId) {
    const item = findMerchant(merchantId)
    if (!item) return
    const flags = item.flags || {}
    openModal(
      '编辑商家 · ' + merchantId,
      '<label>名称<input id="e-name" maxlength="20" value="' + esc(item.name) + '" /></label>' +
        '<label>联系人<input id="e-contact" maxlength="100" value="' + esc(item.contact) + '" /></label>' +
        '<label>套餐<input id="e-plan" value="' + esc(item.plan || 'basic') + '" /></label>' +
        '<label>有效期<input id="e-expires" value="' + esc(item.expiresAt || '') + '" placeholder="如 2027-12-31" /></label>' +
        '<label>状态<select id="e-status"><option value="active"' + (item.status !== 'disabled' ? ' selected' : '') + '>启用</option><option value="disabled"' + (item.status === 'disabled' ? ' selected' : '') + '>停用</option></select></label>' +
        '<label><span><input type="checkbox" id="e-disable-ordering" style="width:auto" ' + (flags.disableOrdering ? 'checked' : '') + ' /> 停用下单</span></label>' +
        '<label><span><input type="checkbox" id="e-pickup" style="width:auto" ' + (flags.pickupOnly ? 'checked' : '') + ' /> 只允许自提</span></label>' +
        '<label>并发订单上限（0 表示不限）<input id="e-max-orders" type="number" min="0" max="500" value="' + esc(flags.maxConcurrentOrders || 0) + '" /></label>'
    )
    modalButton('取消', false, closeModal)
    modalButton('保存', true, async () => {
      try {
        await callFunction('adminApi', 'merchant.update', {
          merchantId,
          name: $('e-name').value.trim(),
          contact: $('e-contact').value.trim(),
          plan: $('e-plan').value.trim() || 'basic',
          expiresAt: $('e-expires').value.trim() || null,
          status: $('e-status').value
        })
        await callFunction('adminApi', 'merchant.setFlags', {
          merchantId,
          flags: {
            disableOrdering: $('e-disable-ordering').checked,
            pickupOnly: $('e-pickup').checked,
            maxConcurrentOrders: Number($('e-max-orders').value) || 0
          }
        })
        closeModal()
        await loadMerchants()
      } catch (err) {
        if (handleAuthError(err)) return
        alert(err.message)
      }
    })
  }

  async function toggleMerchant(merchantId) {
    const item = findMerchant(merchantId)
    if (!item) return
    const next = item.status === 'disabled' ? 'active' : 'disabled'
    if (!confirm((next === 'disabled' ? '停用' : '启用') + '商家 ' + merchantId + '？')) return
    try {
      await callFunction('adminApi', 'merchant.setStatus', { merchantId, status: next })
      await loadMerchants()
    } catch (err) {
      if (handleAuthError(err)) return
      alert(err.message)
    }
  }

  async function resetPassword(merchantId) {
    if (!confirm('重置商家 ' + merchantId + ' 的网页后台密码？')) return
    try {
      const data = await callFunction('adminApi', 'merchant.resetPassword', { merchantId })
      openModal(
        '新密码（只显示这一次）',
        '<p>登录账号：<code>' + esc(data.loginUsername) + '</code></p>' +
          '<div class="secret-box">新密码：<strong>' + esc(data.initialPassword) + '</strong><br>请线下交付给商家；关闭后不再显示。</div>'
      )
      modalButton('我已记录', true, closeModal)
    } catch (err) {
      if (handleAuthError(err)) return
      alert(err.message)
    }
  }

  /* ------------------------------ 员工绑定 ------------------------------ */

  async function openStaff(merchantId) {
    const body = openModal(
      '员工绑定 · ' + merchantId,
      '<div id="staff-list" class="muted">加载中…</div>' +
        '<div class="card" style="margin:12px 0 0">' +
        '<h4 style="margin:0 0 8px">绑定新的 openid</h4>' +
        '<label>openid<input id="s-openid" placeholder="小程序里复制的 openid" /></label>' +
        '<label>角色<select id="s-role"><option value="staff">员工</option><option value="owner">店主</option></select></label>' +
        '<label>备注名<input id="s-name" maxlength="20" placeholder="如 前台小王" /></label>' +
        '<button class="btn small primary" id="s-bind" style="margin-top:8px">绑定</button>' +
        '</div>'
    )
    modalButton('关闭', false, closeModal)

    async function refreshStaff() {
      try {
        const data = await callFunction('adminApi', 'staff.list', { merchantId })
        const list = data.list || []
        const target = body.querySelector('#staff-list')
        if (!list.length) {
          target.innerHTML = '<p class="muted">未绑定员工。商家本人可用小程序里的 openid 绑定为店主。</p>'
          return
        }
        target.innerHTML = list
          .map(
            (item) =>
              '<div class="kv"><span><code>' + esc(item.openid) + '</code> · ' + esc(item.role === 'owner' ? '店主' : '员工') + ' · ' + esc(item.name || '未命名') + '</span>' +
              '<button class="btn small danger" data-openid="' + esc(item.openid) + '">解绑</button></div>'
          )
          .join('')
        target.querySelectorAll('button[data-openid]').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const openid = btn.getAttribute('data-openid')
            if (!confirm('解绑 openid ' + openid + '？')) return
            try {
              await callFunction('adminApi', 'staff.unbind', { merchantId, openid })
              await refreshStaff()
              await loadMerchants()
            } catch (err) {
              if (handleAuthError(err)) return
              alert(err.message)
            }
          })
        })
      } catch (err) {
        if (handleAuthError(err)) return
        body.querySelector('#staff-list').innerHTML = '<span class="error-text">' + esc(err.message) + '</span>'
      }
    }

    body.querySelector('#s-bind').addEventListener('click', async () => {
      const openid = body.querySelector('#s-openid').value.trim()
      if (!openid) {
        alert('请填写 openid')
        return
      }
      try {
        await callFunction('adminApi', 'staff.bind', {
          merchantId,
          openid,
          role: body.querySelector('#s-role').value,
          name: body.querySelector('#s-name').value.trim()
        })
        body.querySelector('#s-openid').value = ''
        await refreshStaff()
        await loadMerchants()
      } catch (err) {
        if (handleAuthError(err)) return
        alert(err.message)
      }
    })

    refreshStaff()
  }

  /* ------------------------------ 健康 / 修复 / 审计 ------------------------------ */

  async function loadHealth() {
    const box = $('health-content')
    box.innerHTML = '<p class="muted">体检中…</p>'
    try {
      const data = await callFunction('adminApi', 'health', {
        merchantId: $('health-merchant-id').value.trim() || 'merchant_001'
      })
      renderHealth(data)
    } catch (err) {
      if (handleAuthError(err)) return
      box.innerHTML = '<p class="error-text">' + esc(err.message) + '</p>'
    }
  }

  function kv(label, value) {
    return '<div class="kv"><span>' + esc(label) + '</span><span>' + esc(value) + '</span></div>'
  }

  function renderHealth(data) {
    const merchant = data.merchant || {}
    const today = data.todayMenu || {}
    const payment = data.payment || {}
    const errors = data.errors || {}
    const byCode = errors.byCode || {}
    const collections = data.collections || []
    const missing = data.missingCollections || []

    const collectionRows = collections
      .map((item) => kv(item.name + '（' + (item.label || '') + '）', item.exists ? item.total + ' 条' : '集合不存在'))
      .join('')

    const errorRows = Object.keys(byCode).length
      ? Object.keys(byCode).map((code) => kv(code, byCode[code] + ' 次')).join('')
      : kv('近 24 小时错误码', '无')

    $('health-content').innerHTML =
      '<div class="health-block"><h4>总体</h4>' +
      kv('状态', data.ok ? '正常' : '需处理') +
      kv('服务器时间', fmtTime(data.serverTime)) +
      kv('默认商家 ID', data.defaultMerchantId) +
      kv('已部署云函数', (data.functions || []).join('、')) +
      '</div>' +
      '<div class="health-block"><h4>租户</h4>' +
      kv('商家 ID', merchant.merchantId) +
      kv('名称', merchant.name || '（缺失）') +
      kv('状态', merchant.status) +
      kv('套餐', merchant.plan || '—') +
      kv('员工数', merchant.staffCount || 0) +
      kv('停用下单', merchant.flags && merchant.flags.disableOrdering ? '是' : '否') +
      kv('只允许自提', merchant.flags && merchant.flags.pickupOnly ? '是' : '否') +
      '</div>' +
      '<div class="health-block"><h4>今日菜单 / 支付</h4>' +
      kv('今日菜单已发布', today.published ? '是' : '否') +
      kv('菜单版本', today.menuVersion || '—') +
      kv('菜单更新时间', fmtTime(today.updatedAt)) +
      kv('发布菜单的租户数', data.todayMenuTenantCount || 0) +
      kv('支付模式', payment.payMode || '—') +
      '</div>' +
      '<div class="health-block"><h4>最近错误（只统计错误码）</h4>' +
      kv('近 24 小时失败次数', errors.last24h || 0) +
      errorRows +
      '</div>' +
      '<div class="health-block"><h4>集合（' + collections.length + '）</h4>' +
      collectionRows +
      (missing.length ? '<p class="error-text">缺失：' + esc(missing.join('、')) + '</p>' : '') +
      '</div>'
  }

  async function runRepair(action) {
    const merchantId = $('repair-merchant-id').value.trim()
    const orderId = $('repair-order-id').value.trim()
    const payload = {}
    if (action !== 'repair.seedDefaults' && action !== 'repair.cleanOrphans' && action !== 'repair.rebuildIndexes') {
      if (!merchantId) {
        alert('请填写目标商家 ID')
        return
      }
      payload.merchantId = merchantId
    }
    if (action === 'repair.resendPaymentCallback') {
      if (!orderId) {
        alert('请填写订单 ID')
        return
      }
      payload.orderId = orderId
    }
    $('repair-result').textContent = '执行中：' + action
    try {
      const data = await callFunction('adminApi', action, payload)
      $('repair-result').textContent = action + '\n' + JSON.stringify(data, null, 2)
    } catch (err) {
      if (handleAuthError(err)) return
      $('repair-result').textContent = action + ' 失败\n' + (err.message || err)
    }
  }

  async function loadAudit() {
    const tbody = $('audit-tbody')
    tbody.innerHTML = '<tr><td colspan="6" class="muted">加载中…</td></tr>'
    try {
      const data = await callFunction('adminApi', 'audit.list', {
        limit: Number($('audit-limit').value) || 50
      })
      const list = data.list || []
      if (!list.length) {
        tbody.innerHTML = '<tr><td colspan="6" class="muted">暂无审计记录</td></tr>'
        return
      }
      tbody.innerHTML = list
        .map(
          (item) =>
            '<tr><td>' + esc(fmtTime(item.at)) + '</td>' +
            '<td>' + esc(item.actorName || item.actorId) + '</td>' +
            '<td><code>' + esc(item.action) + '</code></td>' +
            '<td class="mono">' + esc(item.merchantId || '—') + '</td>' +
            '<td>' + (item.result === 'fail' ? '<span class="badge off">失败</span>' : '<span class="badge ok">成功</span>') + (item.code && item.code !== 'OK' ? ' ' + esc(item.code) : '') + '</td>' +
            '<td>' + esc(item.source || '—') + '</td></tr>'
        )
        .join('')
    } catch (err) {
      if (handleAuthError(err)) return
      tbody.innerHTML = '<tr><td colspan="6" class="error-text">' + esc(err.message) + '</td></tr>'
    }
  }

  async function changePassword() {
    const currentPassword = $('pw-current').value
    const newPassword = $('pw-next').value
    if (!currentPassword || !newPassword) {
      alert('请填写当前密码和新密码')
      return
    }
    try {
      await callFunction('adminApi', 'admin.changePassword', { currentPassword, newPassword })
      $('pw-current').value = ''
      $('pw-next').value = ''
      alert('管理员密码已更新')
    } catch (err) {
      if (handleAuthError(err)) return
      alert(err.message)
    }
  }

  /* ------------------------------ 初始化 ------------------------------ */

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('active', tab.getAttribute('data-tab') === name)
    })
    ;['merchants', 'health', 'repair', 'audit'].forEach((key) => {
      $('tab-' + key).classList.toggle('hidden', key !== name)
    })
    if (name === 'health') loadHealth()
    if (name === 'audit') loadAudit()
  }

  async function refreshAll() {
    if (!token) return
    await loadMerchants()
  }

  function initLoginState() {
    if (typeof AdminLoginState === 'undefined') {
      reportPageError('login-state.js 未加载：登录按钮缺少 loading 反馈（功能仍可用）')
      return
    }
    loginState = AdminLoginState.create(function (state) {
      renderLoginButton(state)
    })
  }

  function initOrigin() {
    const el = $('origin-text')
    if (el) el.textContent = location.origin
    const btn = $('btn-copy-origin')
    if (!btn) return
    btn.addEventListener('click', async () => {
      const okCopy = await copyText(location.origin)
      const old = btn.textContent
      btn.textContent = okCopy ? '已复制' : '复制失败，请手动选中'
      setTimeout(() => { btn.textContent = old }, 1600)
    })
  }

  function checkEnvWarnings() {
    if (location.protocol === 'file:') {
      showBanner('请通过 http(s) 打开页面：直接双击（file://）会导致云端匿名登录失败。可在当前目录执行 npx serve . 或 python -m http.server 8000，再访问 http://localhost:8000/')
      reportPageError('页面以 file:// 打开，云端登录不可用')
    }
    if (window.__SDK_LOAD_FAILED) {
      showBanner('SDK 加载失败：vendor/cloudbase.full.js 未加载或不可读。请确认该文件已随页面上传，或改用单文件版 admin-console-standalone.html（SDK 已内联）。这是脚本问题，不是 400 白名单问题。')
    }
  }

  function init() {
    checkEnvWarnings()
    initLoginState()
    initOrigin()
    $('env-id').value = localStorage.getItem(ENV_KEY) || DEFAULT_ENV
    $('repair-merchant-id').value = 'merchant_001'
    $('health-merchant-id').value = 'merchant_001'

    $('login-form').addEventListener('submit', login)
    $('btn-precheck').addEventListener('click', runPrecheck)
    $('btn-copy-error').addEventListener('click', copyLoginError)
    const copyGlobalBtn = $('btn-copy-global-error')
    if (copyGlobalBtn) {
      copyGlobalBtn.addEventListener('click', async () => {
        const text = ((window.__pageErrors || []).join('\n\n')) || '暂无页面错误'
        const okCopy = await copyText(text)
        const old = copyGlobalBtn.textContent
        copyGlobalBtn.textContent = okCopy ? '已复制' : '复制失败，请手动选中'
        setTimeout(() => { copyGlobalBtn.textContent = old }, 1600)
      })
    }
    $('btn-logout').addEventListener('click', logout)
    $('btn-refresh-all').addEventListener('click', () => {
      refreshAll()
    })
    $('btn-search').addEventListener('click', loadMerchants)
    $('merchant-search').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') loadMerchants()
    })
    $('merchant-status-filter').addEventListener('change', loadMerchants)
    $('btn-create-merchant').addEventListener('click', openCreateMerchant)
    $('btn-health').addEventListener('click', loadHealth)
    $('btn-audit').addEventListener('click', loadAudit)
    $('btn-change-password').addEventListener('click', changePassword)
    $('modal-close').addEventListener('click', closeModal)
    $('modal').addEventListener('click', (e) => {
      if (e.target === $('modal')) closeModal()
    })
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.getAttribute('data-tab')))
    })
    document.querySelectorAll('button[data-repair]').forEach((btn) => {
      btn.addEventListener('click', () => runRepair(btn.getAttribute('data-repair')))
    })

    if (token) {
      showApp()
      refreshAll()
    }

    // 首屏自检：不管有没有 token 都跑，失败项直接给修法
    runPrecheck()
  }

  function boot() {
    try {
      init()
    } catch (err) {
      showBanner('初始化失败：' + errText(err) + '（按 F12 查看 Console 或页面底部错误区）')
      reportPageError('初始化失败：' + ((err && err.stack) || errText(err)))
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
