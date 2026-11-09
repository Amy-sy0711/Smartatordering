(function () {
  'use strict'

  const ENV_KEY = 'ordering_merchant_console_env'
  const TOKEN_KEY = 'ordering_merchant_token'
  const DEFAULT_ENV = 'ordering-d0gyct6z1ff2afebd'

  let cloudApp = null
  let token = sessionStorage.getItem(TOKEN_KEY) || ''
  let lastOrders = []
  let shop = null
  let categories = []
  let dishes = []
  let menuData = null
  let selectedDishIds = []
  let editingDish = null

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

  /** 分 -> '12.50'，全程整数运算，避免浮点误差 */
  function money(cents) {
    let value = Number(cents)
    if (!Number.isFinite(value)) value = 0
    value = Math.trunc(value)
    const sign = value < 0 ? '-' : ''
    const abs = Math.abs(value)
    const yuan = (abs - (abs % 100)) / 100
    const fen = abs % 100
    return sign + String(yuan) + '.' + (fen < 10 ? '0' + fen : String(fen))
  }

  function todayKey() {
    const now = new Date()
    const shanghai = new Date(now.getTime() + 8 * 3600 * 1000)
    return shanghai.toISOString().slice(0, 10)
  }

  function currentDate() {
    return $('global-date').value || todayKey()
  }

  function toast(message) {
    const div = document.createElement('div')
    div.textContent = message
    div.style.cssText =
      'position:fixed;left:50%;bottom:36px;transform:translateX(-50%);background:#10281c;color:#fff;padding:10px 18px;border-radius:10px;z-index:60;font-size:13px;box-shadow:0 6px 18px rgba(0,0,0,.2)'
    document.body.appendChild(div)
    setTimeout(() => div.remove(), 2200)
  }

  async function ensureApp() {
    if (cloudApp) return cloudApp
    const env = ($('env-id').value || '').trim() || DEFAULT_ENV
    localStorage.setItem(ENV_KEY, env)
    if (typeof cloudbase === 'undefined') throw new Error('CloudBase JS SDK 未加载')
    cloudApp = cloudbase.init({ env })
    const auth = cloudApp.auth({ persistence: 'session' })
    try {
      if (typeof auth.signInAnonymously === 'function') await auth.signInAnonymously()
      else if (typeof auth.anonymousAuth === 'function') await auth.anonymousAuth()
    } catch (err) {
      console.warn('[merchant-console] 匿名登录', err)
    }
    $('conn-status').textContent = '已连接 ' + env
    return cloudApp
  }

  async function callFunction(name, action, payload, withToken) {
    await ensureApp()
    const body = { action, payload: Object.assign({}, payload || {}) }
    if (withToken !== false) body.payload.token = token
    const res = await cloudApp.callFunction({ name, data: body })
    const result = (res && res.result) || {}
    if (result.code !== 0) {
      const err = new Error(result.message || '接口失败：' + result.code)
      err.code = result.code
      throw err
    }
    return result.data
  }

  function callApi(action, payload) {
    return callFunction('api', action, payload)
  }

  function handleAuthError(err) {
    const code = err && err.code
    if (
      code === 'TOKEN_EXPIRED' ||
      code === 'TOKEN_FORGED' ||
      code === 'TOKEN_INVALID' ||
      code === 'TOKEN_REVOKED' ||
      code === 'MERCHANT_DISABLED' ||
      code === 'MERCHANT_NOT_FOUND'
    ) {
      logout()
      $('login-error').textContent = (err && err.message) || '登录已失效，请重新登录'
      return true
    }
    return false
  }

  /* ------------------------------ 登录 ------------------------------ */

  async function login(event) {
    if (event) event.preventDefault()
    $('login-error').textContent = ''
    try {
      const data = await callFunction(
        'merchantAuth',
        'login',
        { username: $('login-username').value.trim(), password: $('login-password').value },
        false
      )
      token = data.token
      shop = data.merchant
      sessionStorage.setItem(TOKEN_KEY, token)
      $('login-panel').classList.add('hidden')
      $('app-panel').classList.remove('hidden')
      $('shop-label').textContent = (shop.name || shop.merchantId) + ' · 商家后台'
      $('shop-meta').textContent = '商家 ID：' + shop.merchantId + ' · 账号：' + (shop.username || '')
      await loadAll()
    } catch (err) {
      $('login-error').textContent = err.message || '登录失败'
    }
  }

  function logout() {
    token = ''
    shop = null
    sessionStorage.removeItem(TOKEN_KEY)
    $('app-panel').classList.add('hidden')
    $('login-panel').classList.remove('hidden')
  }

  /* ------------------------------ 数据加载 ------------------------------ */

  async function loadAll() {
    $('global-date').value = $('global-date').value || todayKey()
    try {
      const results = await Promise.all([
        callApi('merchant.listDishes'),
        callApi('merchant.listCategories'),
        callApi('merchant.menuDetail', { date: currentDate() })
      ])
      dishes = results[0].list || []
      categories = results[1].list || []
      menuData = results[2] || {}
      const previous = Array.isArray(menuData.dishIds) ? menuData.dishIds : []
      selectedDishIds = previous.length
        ? previous.slice()
        : dishes.filter((dish) => dish.onSale !== false).map((dish) => dish.dishId || dish._id)
      renderDishes()
      renderCategories()
      renderMenuPanel()
      loadOrders()
      loadPacking()
      loadStats()
      loadStaff()
    } catch (err) {
      if (handleAuthError(err)) return
      alert(err.message)
    }
  }

  function refreshData() {
    loadAll()
  }

  /* ------------------------------ 菜品 ------------------------------ */

  function dishIdOf(dish) {
    return dish.dishId || dish._id || ''
  }

  function renderDishes() {
    const tbody = $('dish-tbody')
    if (!dishes.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">还没有菜品，点「新增菜品」创建。</td></tr>'
      return
    }
    tbody.innerHTML = dishes
      .map((dish) => {
        const id = dishIdOf(dish)
        const checked = selectedDishIds.indexOf(id) >= 0
        return (
          '<tr>' +
          '<td><input type="checkbox" style="width:auto" data-pick="' + esc(id) + '" ' + (checked ? 'checked' : '') + ' ' + (dish.onSale === false ? 'disabled' : '') + ' /></td>' +
          '<td>' + esc(dish.name) + (dish.imageUrl ? ' <span class="muted">（有图）</span>' : '') + '</td>' +
          '<td>' + esc(dish.category || '其他') + '</td>' +
          '<td>¥' + esc(money(dish.priceCents)) + '</td>' +
          '<td>' + esc(dish.sortOrder || 0) + '</td>' +
          '<td>' + (dish.onSale === false ? '<span class="badge off">下架</span>' : '<span class="badge ok">上架</span>') + (dish.soldOut ? ' <span class="badge warn">售罄</span>' : '') + '</td>' +
          '<td class="row">' +
          '<button class="btn small" data-dish="' + esc(id) + '" data-op="edit">编辑</button>' +
          '<button class="btn small" data-dish="' + esc(id) + '" data-op="toggleSale">' + (dish.onSale === false ? '上架' : '下架') + '</button>' +
          '<button class="btn small" data-dish="' + esc(id) + '" data-op="toggleSoldOut">' + (dish.soldOut ? '恢复' : '售罄') + '</button>' +
          '<button class="btn small danger" data-dish="' + esc(id) + '" data-op="delete">删除</button>' +
          '</td></tr>'
        )
      })
      .join('')

    tbody.querySelectorAll('input[data-pick]').forEach((box) => {
      box.addEventListener('change', () => {
        const id = box.getAttribute('data-pick')
        const index = selectedDishIds.indexOf(id)
        if (box.checked && index < 0) selectedDishIds.push(id)
        if (!box.checked && index >= 0) selectedDishIds.splice(index, 1)
      })
    })
    tbody.querySelectorAll('button[data-dish]').forEach((btn) => {
      btn.addEventListener('click', () => dishAction(btn.getAttribute('data-dish'), btn.getAttribute('data-op')))
    })
  }

  async function dishAction(dishId, op) {
    const dish = dishes.filter((item) => dishIdOf(item) === dishId)[0]
    if (!dish) return
    try {
      if (op === 'edit') {
        openDishModal(dish)
      } else if (op === 'toggleSale') {
        await callApi('merchant.toggleDish', { dishId, field: 'onSale', value: dish.onSale === false })
        await refreshData()
        toast('菜品状态已更新')
      } else if (op === 'toggleSoldOut') {
        await callApi('merchant.toggleDish', { dishId, field: 'soldOut', value: dish.soldOut !== true })
        await refreshData()
        toast('菜品状态已更新')
      } else if (op === 'delete') {
        if (!confirm('删除菜品「' + dish.name + '」？')) return
        await callApi('merchant.deleteDish', { dishId })
        await refreshData()
        toast('菜品已删除')
      }
    } catch (err) {
      if (handleAuthError(err)) return
      alert(err.message)
    }
  }

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
  }

  function categoryOptions(selected) {
    const names = categories
      .filter((item) => item.enabled !== false)
      .map((item) => item.name)
    if (names.indexOf('其他') < 0) names.push('其他')
    if (selected && names.indexOf(selected) < 0) names.unshift(selected)
    return names
      .map((name) => '<option value="' + esc(name) + '"' + (name === selected ? ' selected' : '') + '>' + esc(name) + '</option>')
      .join('')
  }

  function openDishModal(dish) {
    editingDish = dish || null
    const item = dish || { name: '', category: '其他', priceCents: 0, sortOrder: 0, imageUrl: '', onSale: true, soldOut: false }
    const body = openModal(
      dish ? '编辑菜品' : '新增菜品',
      '<label>菜品名称（必填，≤20 字）<input id="d-name" maxlength="20" value="' + esc(item.name) + '" /></label>' +
        '<label>分类<select id="d-category">' + categoryOptions(item.category) + '</select></label>' +
        '<label>价格（元）<input id="d-price" type="number" min="0" step="0.01" value="' + esc(money(item.priceCents)) + '" /></label>' +
        '<label>排序（数字越小越靠前）<input id="d-sort" type="number" value="' + esc(item.sortOrder || 0) + '" /></label>' +
        '<label>图片 URL（可选）<input id="d-image" value="' + esc(item.imageUrl || '') + '" /></label>' +
        '<label><span><input type="checkbox" id="d-onsale" style="width:auto" ' + (item.onSale !== false ? 'checked' : '') + ' /> 上架</span></label>' +
        '<label><span><input type="checkbox" id="d-soldout" style="width:auto" ' + (item.soldOut ? 'checked' : '') + ' /> 标记售罄</span></label>' +
        '<p class="muted">菜品规格（多规格加价）仍在小程序商家端维护；本页保存会保留已有规格。</p>'
    )
    modalButton('取消', false, closeModal)
    modalButton('保存', true, async () => {
      const name = body.querySelector('#d-name').value.trim()
      const price = Number(body.querySelector('#d-price').value)
      if (!name) {
        alert('请填写菜品名称')
        return
      }
      if (!Number.isFinite(price) || price < 0 || price > 10000) {
        alert('价格需为 0-10000 元')
        return
      }
      const payload = {
        dish: {
          name,
          category: body.querySelector('#d-category').value,
          priceCents: Math.round(price * 100),
          sortOrder: Number(body.querySelector('#d-sort').value) || 0,
          imageUrl: body.querySelector('#d-image').value.trim(),
          onSale: body.querySelector('#d-onsale').checked,
          soldOut: body.querySelector('#d-soldout').checked,
          specs: (editingDish && editingDish.specs) || []
        }
      }
      if (editingDish) payload.dishId = dishIdOf(editingDish)
      try {
        await callApi('merchant.saveDish', payload)
        closeModal()
        await refreshData()
        toast('菜品已保存')
      } catch (err) {
        if (handleAuthError(err)) return
        alert(err.message)
      }
    })
  }

  /* ------------------------------ 分类 ------------------------------ */

  function renderCategories() {
    const box = $('category-list')
    if (!categories.length) {
      box.innerHTML = '<p class="muted">还没有分类，新增后可在菜品里选择。</p>'
      return
    }
    box.innerHTML = categories
      .map((cat, index) => {
        return (
          '<div class="category-row">' +
          '<input value="' + esc(cat.name) + '" data-cat-name="' + esc(cat.categoryId) + '" maxlength="12" />' +
          '<span class="badge ' + (cat.enabled === false ? 'off' : 'ok') + '">' + (cat.enabled === false ? '停用' : '启用') + '</span>' +
          '<span class="muted">排序 ' + esc(cat.sort) + '</span>' +
          '<button class="btn small" data-cat="' + esc(cat.categoryId) + '" data-op="up" ' + (index === 0 ? 'disabled' : '') + '>↑</button>' +
          '<button class="btn small" data-cat="' + esc(cat.categoryId) + '" data-op="down" ' + (index === categories.length - 1 ? 'disabled' : '') + '>↓</button>' +
          '<button class="btn small" data-cat="' + esc(cat.categoryId) + '" data-op="toggle">' + (cat.enabled === false ? '启用' : '停用') + '</button>' +
          '<button class="btn small danger" data-cat="' + esc(cat.categoryId) + '" data-op="delete">删除</button>' +
          '</div>'
        )
      })
      .join('')

    box.querySelectorAll('input[data-cat-name]').forEach((input) => {
      input.addEventListener('blur', () => renameCategory(input.getAttribute('data-cat-name'), input.value.trim()))
    })
    box.querySelectorAll('button[data-cat]').forEach((btn) => {
      btn.addEventListener('click', () => categoryAction(btn.getAttribute('data-cat'), btn.getAttribute('data-op')))
    })
  }

  async function addCategory() {
    const name = $('new-category').value.trim()
    if (!name) {
      alert('请填写分类名称')
      return
    }
    try {
      await callApi('merchant.saveCategory', { name })
      $('new-category').value = ''
      await refreshData()
      toast('分类已新增')
    } catch (err) {
      if (handleAuthError(err)) return
      alert(err.message)
    }
  }

  async function renameCategory(categoryId, name) {
    const cat = categories.filter((item) => item.categoryId === categoryId)[0]
    if (!cat || !name || name === cat.name) return
    try {
      await callApi('merchant.saveCategory', { categoryId, name, enabled: cat.enabled })
      await refreshData()
      toast('分类已重命名')
    } catch (err) {
      if (handleAuthError(err)) return
      alert(err.message)
    }
  }

  async function categoryAction(categoryId, op) {
    const cat = categories.filter((item) => item.categoryId === categoryId)[0]
    if (!cat) return
    try {
      if (op === 'toggle') {
        await callApi('merchant.saveCategory', { categoryId, enabled: cat.enabled === false })
      } else if (op === 'up' || op === 'down') {
        const index = categories.indexOf(cat)
        const target = index + (op === 'up' ? -1 : 1)
        if (target < 0 || target >= categories.length) return
        const list = categories.slice()
        list[index] = list[target]
        list[target] = cat
        await Promise.all(
          list.map((item, i) =>
            callApi('merchant.saveCategory', {
              categoryId: item.categoryId,
              name: item.name,
              sort: i + 1,
              enabled: item.enabled
            })
          )
        )
      } else if (op === 'delete') {
        if (!confirm('删除分类「' + cat.name + '」？该分类下的菜品会归入「其他」。')) return
        await callApi('merchant.deleteCategory', { categoryId })
      }
      await refreshData()
    } catch (err) {
      if (handleAuthError(err)) return
      alert(err.message)
    }
  }

  /* ------------------------------ 今日菜单 ------------------------------ */

  function renderMenuPanel() {
    const slots = Array.isArray(menuData.slots) ? menuData.slots : []
    if (slots.length) {
      $('menu-slots').value = slots.map((slot) => slot.label + '|' + slot.limit).join(',')
    } else {
      $('menu-slots').value = '午餐|20,晚餐|20'
    }
    $('menu-title').value = menuData.title || '今日菜单'
    $('menu-status').textContent = menuData.published
      ? '已发布：' + (menuData.dateLabel || menuData.date) + ' · ' + (menuData.dishIds || []).length + ' 个菜品'
      : '今日尚未发布菜单，勾选菜品后点发布'
    $('today-badge').textContent = currentDate() === todayKey() ? '今日' : currentDate()
  }

  function parseSlots(text) {
    return String(text || '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const pieces = part.split('|')
        return { label: pieces[0].trim(), limit: Number(pieces[1]) || 20 }
      })
  }

  async function publishMenu() {
    if (!selectedDishIds.length) {
      alert('请至少勾选一个菜品再发布')
      return
    }
    try {
      await callApi('merchant.publishMenu', {
        date: currentDate(),
        title: $('menu-title').value.trim() || '今日菜单',
        slots: parseSlots($('menu-slots').value),
        dishIds: selectedDishIds.slice()
      })
      await refreshData()
      toast('已发布，顾客端刷新即可见')
    } catch (err) {
      if (handleAuthError(err)) return
      alert(err.message)
    }
  }

  /* ------------------------------ 订单 ------------------------------ */

  async function loadOrders() {
    const box = $('order-list')
    box.innerHTML = '<p class="muted">加载中…</p>'
    try {
      const filter = $('order-status-filter').value
      const payload = { date: currentDate() }
      if (filter) payload.statuses = [filter]
      const data = await callApi('merchant.orders', payload)
      const list = data.list || []
      lastOrders = list
      if (!list.length) {
        box.innerHTML = '<p class="muted">' + esc(data.dateLabel || currentDate()) + ' 暂无订单。</p>'
        return
      }
      box.innerHTML = list
        .map((order) => {
          const items = (order.items || [])
            .map((item) => esc(item.name) + (item.specText ? '（' + esc(item.specText) + '）' : '') + ' ×' + esc(item.qty))
            .join('<br>')
          return (
            '<div class="order-card">' +
            '<div class="order-head"><strong>#' + esc(order.orderNo) + ' · ' + esc(order.statusText || order.status) + '</strong><span>¥' + esc(order.totalText) + '</span></div>' +
            '<div class="order-meta">取餐：' + esc(order.slotLabel || '—') + ' · ' + esc(order.createdAtText || '') + '</div>' +
            (order.isStale ? '<div class="order-meta">非今日订单（' + esc(order.date || '') + '）待收款</div>' : '') +
            '<div class="order-items">' + items + '</div>' +
            (order.transferNote ? '<div class="order-meta">转账备注：' + esc(order.transferNote) + '</div>' : '') +
            (order.remark ? '<div class="order-meta">顾客备注：' + esc(order.remark) + '</div>' : '') +
            '<div class="order-actions">' + orderActions(order) + '</div>' +
            '</div>'
          )
        })
        .join('')
      box.querySelectorAll('button[data-order]').forEach((btn) => {
        btn.addEventListener('click', () => orderAction(btn.getAttribute('data-order'), btn.getAttribute('data-op')))
      })
    } catch (err) {
      if (handleAuthError(err)) return
      box.innerHTML = '<p class="error-text">' + esc(err.message) + '</p>'
    }
  }

  function orderActions(order) {
    const buttons = []
    const id = order._id || order.orderId
    // 以服务端下发的 needConfirmReceipt 为准：pending_pay / pending_confirm 都要能确认收款
    const needConfirm = typeof order.needConfirmReceipt === 'boolean'
      ? order.needConfirmReceipt
      : ['pending_pay', 'pending_confirm'].indexOf(order.status) >= 0
    if (needConfirm) {
      buttons.push('<button class="btn small primary" data-order="' + esc(id) + '" data-op="confirm">确认收款</button>')
    }
    // 已收款即可出餐；accepted 仅兼容历史订单，新流程不再产生
    if (order.status === 'paid' || order.status === 'accepted') {
      buttons.push('<button class="btn small primary" data-order="' + esc(id) + '" data-op="ready">出餐（生成取餐码）</button>')
    }
    if (order.status === 'ready') buttons.push('<button class="btn small primary" data-order="' + esc(id) + '" data-op="complete">已取餐</button>')
    if (['pending_pay', 'pending_confirm', 'paid', 'accepted', 'ready'].indexOf(order.status) >= 0) {
      buttons.push('<button class="btn small danger" data-order="' + esc(id) + '" data-op="cancel">取消</button>')
    }
    return buttons.join('') || '<span class="muted">无可执行操作</span>'
  }

  async function orderAction(orderId, op) {
    try {
      if (op === 'confirm') {
        const order = (lastOrders || []).filter((item) => (item._id || item.orderId) === orderId)[0] || {}
        const ok = confirm(
          '确认已收到 ¥' + (order.totalText || '') + '（订单 #' + (order.orderNo || orderId) + '）？\n确认后订单进入备餐，再点「出餐（生成取餐码）」生成取餐码。'
        )
        if (!ok) return
        await callApi('merchant.confirmReceipt', { orderId })
        toast('已确认收款')
      } else if (op === 'cancel') {
        if (!confirm('取消订单？已收款订单会被标记退款。')) return
        await callApi('merchant.transition', { orderId, action: 'cancel' })
        toast('订单已取消')
      } else {
        await callApi('merchant.transition', { orderId, action: op })
        toast('订单状态已更新')
      }
      loadOrders()
      loadPacking()
      loadStats()
    } catch (err) {
      if (handleAuthError(err)) return
      // 失败必须带服务端 code，便于用户反馈定位（越权 / 状态已变化 / 重复确认）
      alert((err && err.code ? err.code + '：' : '') + ((err && err.message) || '操作失败'))
    }
  }

  /* ------------------------------ 打包 ------------------------------ */

  async function loadPacking() {
    const box = $('packing-content')
    try {
      const data = await callApi('merchant.packing', { date: currentDate() })
      const groups = data.groups || []
      const orders = data.orders || []
      box.innerHTML =
        '<div class="summary-grid">' +
        '<div class="summary-card"><div class="summary-value">' + esc(data.orderCount || 0) + '</div><div class="summary-label">待打包订单</div></div>' +
        '<div class="summary-card"><div class="summary-value">' + esc(data.itemCount || 0) + '</div><div class="summary-label">总份数</div></div>' +
        '</div>' +
        '<div class="card"><h4>按菜品汇总</h4>' +
        (groups.length
          ? groups.map((g) => '<div class="kv"><span>' + esc(g.name) + (g.specText ? '（' + esc(g.specText) + '）' : '') + '</span><span>' + esc(g.qty) + ' 份</span></div>').join('')
          : '<p class="muted">暂无待打包菜品</p>') +
        '</div>' +
        '<div class="card"><h4>逐单勾选</h4>' +
        (orders.length
          ? orders
              .map(
                (order) =>
                  '<div class="category-row"><span>#' + esc(order.orderNo) + ' · ' + esc(order.slotLabel || '—') + ' · ' + esc(order.itemCount) + ' 份 ' +
                  (order.packed ? '<span class="badge ok">已打包</span>' : '<span class="badge warn">待打包</span>') + '</span>' +
                  '<button class="btn small" data-pack="' + esc(order.orderId) + '" data-packed="' + (order.packed ? 'true' : 'false') + '">' + (order.packed ? '取消打包' : '标记已打包') + '</button></div>'
              )
              .join('')
          : '<p class="muted">暂无订单</p>') +
        '</div>'
      box.querySelectorAll('button[data-pack]').forEach((btn) => {
        btn.addEventListener('click', () => setPacked(btn.getAttribute('data-pack'), btn.getAttribute('data-packed') !== 'true'))
      })
    } catch (err) {
      if (handleAuthError(err)) return
      box.innerHTML = '<p class="error-text">' + esc(err.message) + '</p>'
    }
  }

  async function setPacked(orderId, packed) {
    try {
      await callApi('merchant.setPacked', { orderId, packed })
      loadPacking()
    } catch (err) {
      if (handleAuthError(err)) return
      alert(err.message)
    }
  }

  /* ------------------------------ 营收 ------------------------------ */

  async function loadStats() {
    const box = $('stats-content')
    try {
      const data = await callApi('merchant.stats', { date: currentDate() })
      const rank = data.dishRank || []
      box.innerHTML =
        '<div class="summary-grid">' +
        '<div class="summary-card"><div class="summary-value">¥' + esc(data.paidCentsText) + '</div><div class="summary-label">已收款（' + esc(data.paidCount) + ' 单）</div></div>' +
        '<div class="summary-card"><div class="summary-value">¥' + esc(data.pendingConfirmCentsText) + '</div><div class="summary-label">待确认（' + esc(data.pendingConfirmCount) + ' 单）</div></div>' +
        '<div class="summary-card"><div class="summary-value">¥' + esc(data.pendingPayCentsText) + '</div><div class="summary-label">待付款（' + esc(data.pendingPayCount) + ' 单）</div></div>' +
        '<div class="summary-card"><div class="summary-value">¥' + esc(data.refundCentsText) + '</div><div class="summary-label">退款 / 取消（' + esc(data.refundCount) + ' 单）</div></div>' +
        '</div>' +
        '<div class="card"><h4>销量排行</h4>' +
        (rank.length
          ? '<div class="table-wrap"><table class="data-table"><thead><tr><th>菜品</th><th>销量</th><th>销售额</th></tr></thead><tbody>' +
            rank.map((item) => '<tr><td>' + esc(item.name) + '</td><td>' + esc(item.qty) + '</td><td>¥' + esc(money(item.salesCents)) + '</td></tr>').join('') +
            '</tbody></table></div>'
          : '<p class="muted">暂无已收款订单</p>') +
        '</div>'
    } catch (err) {
      if (handleAuthError(err)) return
      box.innerHTML = '<p class="error-text">' + esc(err.message) + '</p>'
    }
  }

  /* ------------------------------ 员工 ------------------------------ */

  async function loadStaff() {
    const box = $('staff-list')
    try {
      const data = await callApi('merchant.staffList')
      const list = data.list || []
      if (!list.length) {
        box.innerHTML = '<p class="muted">还没有绑定员工；店主可把自己的 openid 绑定为 owner。</p>'
        return
      }
      box.innerHTML = list
        .map(
          (item) =>
            '<div class="category-row"><span><code>' + esc(item.openid) + '</code> · ' + esc(item.role === 'owner' ? '店主' : '员工') + ' · ' + esc(item.name || '未命名') + '</span>' +
            (item.role === 'owner' ? '<span class="badge ok">店主</span>' : '<button class="btn small danger" data-staff="' + esc(item.openid) + '">解绑</button>') +
            '</div>'
        )
        .join('')
      box.querySelectorAll('button[data-staff]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const openid = btn.getAttribute('data-staff')
          if (!confirm('解绑员工 ' + openid + '？')) return
          try {
            await callApi('merchant.staffUnbind', { openid })
            loadStaff()
            toast('已解绑')
          } catch (err) {
            if (handleAuthError(err)) return
            alert(err.message)
          }
        })
      })
    } catch (err) {
      if (handleAuthError(err)) return
      box.innerHTML = '<p class="error-text">' + esc(err.message) + '</p>'
    }
  }

  async function bindStaff() {
    const openid = $('staff-openid').value.trim()
    if (!openid) {
      alert('请填写员工小程序 openid')
      return
    }
    try {
      await callApi('merchant.staffBind', {
        openid,
        role: $('staff-role').value,
        name: $('staff-name').value.trim()
      })
      $('staff-openid').value = ''
      $('staff-name').value = ''
      loadStaff()
      toast('员工已绑定')
    } catch (err) {
      if (handleAuthError(err)) return
      alert(err.message)
    }
  }

  /* ------------------------------ 导出 ------------------------------ */

  async function exportCsv() {
    try {
      const data = await callApi('merchant.exportOrders', { date: currentDate() })
      if (!data.count) {
        $('export-result').textContent = '当前日期没有可导出的订单。'
        return
      }
      const blob = new Blob(['\ufeff' + data.csv], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'orders-' + data.date + '.csv'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      $('export-result').textContent = '已导出 ' + data.count + ' 条订单（' + data.date + '），本次导出已写入审计日志。'
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
    ;['menu', 'categories', 'orders', 'packing', 'stats', 'staff', 'export'].forEach((key) => {
      $('tab-' + key).classList.toggle('hidden', key !== name)
    })
    if (name === 'orders') loadOrders()
    if (name === 'packing') loadPacking()
    if (name === 'stats') loadStats()
    if (name === 'staff') loadStaff()
  }

  function init() {
    $('env-id').value = localStorage.getItem(ENV_KEY) || DEFAULT_ENV
    $('global-date').value = todayKey()
    $('login-form').addEventListener('submit', login)
    $('btn-logout').addEventListener('click', logout)
    $('btn-refresh').addEventListener('click', refreshData)
    $('global-date').addEventListener('change', refreshData)
    $('btn-new-dish').addEventListener('click', () => openDishModal(null))
    $('btn-publish').addEventListener('click', publishMenu)
    $('btn-add-category').addEventListener('click', addCategory)
    $('btn-orders').addEventListener('click', loadOrders)
    $('order-status-filter').addEventListener('change', loadOrders)
    $('btn-packing').addEventListener('click', loadPacking)
    $('btn-stats').addEventListener('click', loadStats)
    $('btn-bind-staff').addEventListener('click', bindStaff)
    $('btn-export').addEventListener('click', exportCsv)
    $('modal-close').addEventListener('click', closeModal)
    $('modal').addEventListener('click', (e) => {
      if (e.target === $('modal')) closeModal()
    })
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => switchTab(tab.getAttribute('data-tab')))
    })
    if (token) {
      $('login-panel').classList.add('hidden')
      $('app-panel').classList.remove('hidden')
      loadAll()
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()
