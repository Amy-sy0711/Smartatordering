const api = require('../../utils/data-source')
const cartUtil = require('../../utils/cart')
const cartSheet = require('../../utils/cart-sheet')
const payment = require('../../utils/payment')
const safe = require('../../utils/safe')
const merchantContext = require('../../utils/merchant-context')
const categoryScroll = require('../../utils/category-scroll')
const imagePreview = require('../../utils/image-preview')

Page({
  data: {
    loading: true,
    loadState: 'loading', // loading | load_failed | empty | ready
    published: false,
    menu: null,
    categories: [],
    slots: [],
    totalDishes: 0,
    dateLabel: '',
    shop: null,
    paySettings: payment.FALLBACK_SETTINGS,
    cartCount: 0,
    cartTotalText: '0.00',
    cartSheetVisible: false,
    cartRows: [],
    cartSheetCount: 0,
    cartSheetTotalText: '0.00',
    isMerchant: false,
    isPlatformAdmin: false,
    canBootstrap: false,
    modeLabel: '',
    isLocal: false,
    identity: null,
    identityError: null,
    fromMerchant: false,
    errorCode: '',
    errorMsg: '',
    errorHint: '',
    pickerVisible: false,
    pickerDish: null,
    showRail: false,
    activeCategory: 0,
    menuAreaHeight: 0,
    tailHeight: 0,
    scrollIntoView: '',
    railScrollIntoView: '',
    refreshing: false
  },

  onLoad(options) {
    this.dishMap = {}
    this.categoryOffsets = []
    this.imageFailedUrls = []
    this.lastScrollTop = 0
    this.suppressSpy = false
    const fromMerchant = !!(options && options.from === 'merchant')
    // 商家预览顾客端时同样脱敏；真实顾客才显示完整排障信息
    api.setErrorPrivacy(fromMerchant)
    merchantContext.capture(options)
    this.setData({ fromMerchant: fromMerchant })
    const app = getApp()
    const globalData = (app && app.globalData) || {}
    this.setData({
      identity: globalData.identity || null,
      identityError: globalData.identityError || null,
      isPlatformAdmin: !!(globalData.identity && globalData.identity.role === 'admin')
    })
    this.refresh(true)
  },

  onShow() {
    this.refreshCart()
  },

  onPullDownRefresh() {
    this.refresh(false).then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh())
  },

  /** 列表在 scroll-view 内，页面级下拉刷新可能触发不到，补一个列表内下拉刷新 */
  onRefresherRefresh() {
    this.setData({ refreshing: true })
    this.refresh(false).then(
      () => this.setData({ refreshing: false }),
      () => this.setData({ refreshing: false })
    )
  },

  refresh(showLoading) {
    const env = api.getEnvInfo()
    this.setData({ modeLabel: env.modeLabel, isLocal: env.isLocal })
    if (showLoading !== false) wx.showLoading({ title: '加载菜单', mask: true })
    return Promise.all([
      api.call('menu.today'),
      api.call('merchant.checkAccess').catch(() => ({ isMerchant: false, canBootstrap: false }))
    ])
      .then((results) => {
        const menu = results[0] || {}
        const access = results[1] || {}
        const dishMap = {}
        const categories = safe.safeArray(menu.categories).map((category) => {
          const src = category || {}
          return {
            name: safe.safeText(src.name, '其他'),
            dishes: safe.safeArray(src.dishes).map((dish) => {
              const item = dish || {}
              const view = Object.assign({}, item, {
                name: safe.safeText(item.name, '未命名菜品'),
                priceText: safe.safeText(item.priceText, '0.00'),
                initial: safe.safeText(item.initial, safe.safeText(item.name, '菜').slice(0, 1)),
                specs: safe.safeArray(item.specs)
              })
              dishMap[view._id] = view
              return view
            })
          }
        })
        // 时段字段全部兜底：旧数据（字符串时段 / 缺 limit / 缺 left）也不会出现「剩undefined」
        const slots = safe.safeArray(menu.slots).map((slot, index) => {
          const src = slot || {}
          const limit = safe.safeInt(src.limit, 20)
          const used = safe.safeInt(src.used, 0)
          const left = typeof src.left === 'number' ? safe.safeInt(src.left, 0) : Math.max(limit - used, 0)
          return {
            id: safe.safeText(src.id, 's' + (index + 1)),
            label: safe.safeText(src.label, '取餐时段'),
            limit,
            left,
            full: !!src.full,
            // 模板只读兜底后的文案，避免 WXML 里拼接可能为 undefined 的字段
            leftText: src.full ? '已满' : '剩' + left
          }
        })
        this.dishMap = dishMap
        // 菜单数据变化后旧偏移全部失效，等渲染完成再重新测量
        this.categoryOffsets = []
        this.lastScrollTop = 0
        this.setData(
          {
            loading: false,
            loadState: menu.published ? 'ready' : 'empty',
            published: !!menu.published,
            menu: {
              title: safe.safeText(menu.title, '今日菜单'),
              dateLabel: safe.safeText(menu.dateLabel, ''),
              date: safe.safeText(menu.date, '')
            },
            categories,
            showRail: categoryScroll.shouldShowRail(categories.length),
            activeCategory: 0,
            scrollIntoView: '',
            railScrollIntoView: '',
            slots,
            totalDishes: safe.safeInt(menu.totalDishes, 0),
            dateLabel: safe.safeText(menu.dateLabel, ''),
            shop: menu.shop || null,
            paySettings: menu.payment || payment.FALLBACK_SETTINGS,
            isMerchant: !!access.isMerchant,
            isPlatformAdmin: access.role === 'admin',
            canBootstrap: false,
            errorCode: '',
            errorMsg: '',
            errorHint: ''
          },
          () => {
            if (menu.published) this.scheduleMeasure()
          }
        )
        this.refreshCart()
      })
      .catch((err) => {
        // 云端/本地调用失败：不静默吞掉，页面展示可复制的错误信息
        console.error('[menu] 菜单加载失败', err)
        const info = api.describeError(err)
        // 商家预览视角不展示错误码/环境细节，只给可行动提示
        const merchantPreview = this.data.fromMerchant
        this.setData({
          loading: false,
          loadState: 'load_failed',
          published: false,
          isMerchant: false,
          isPlatformAdmin: false,
          canBootstrap: false,
          errorCode: merchantPreview ? '' : info.code,
          errorMsg: merchantPreview ? '系统暂时不可用' : info.message,
          errorHint: merchantPreview ? '系统暂时不可用，请联系管理员。' : info.hint,
          modeLabel: info.modeLabel,
          isLocal: info.mode === api.MODE_LOCAL
        })
      })
      .then(() => {
        if (showLoading !== false) wx.hideLoading()
      })
  },

  refreshCart() {
    const lines = cartUtil.load()
    const totals = cartUtil.totals(lines)
    const patch = { cartCount: totals.count, cartTotalText: totals.text }
    // 弹层打开时同步重算行与合计，避免和底部条数字不一致
    if (this.data.cartSheetVisible) {
      const rows = cartSheet.buildRows(lines, this.dishMap)
      const info = cartSheet.summary(rows)
      patch.cartRows = rows
      patch.cartSheetCount = info.count
      patch.cartSheetTotalText = info.text
    }
    this.setData(patch)
  },

  retry() {
    this.refresh(true)
  },

  /* 左侧分类栏 ↔ 右侧列表滚动联动 */

  scheduleMeasure() {
    if (this.measureTimer) clearTimeout(this.measureTimer)
    this.measureTimer = setTimeout(() => this.measureLayout(), 60)
  },

  /** 先按视口高度给右侧列表定高，再测量各分类标题相对滚动容器的偏移 */
  measureLayout() {
    if (!this.data.categories.length) {
      this.categoryOffsets = []
      return
    }
    const info = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()) || {}
    const winHeight = Number(info.windowHeight) || 0
    const winWidth = Number(info.windowWidth) || 375
    const query = wx.createSelectorQuery().in(this)
    query.select('.menu-body').boundingClientRect()
    query.exec((res) => {
      const rect = res && res[0]
      if (!rect || !winHeight) {
        this.measureCategoryOffsets()
        return
      }
      // 给底部悬浮购物车留空间（约 150rpx）+ 20px 安全距离
      const bottomSpace = Math.round((150 * winWidth) / 750) + 20
      const height = Math.max(Math.round(winHeight - rect.top - bottomSpace), 260)
      this.setData({ menuAreaHeight: height, tailHeight: Math.max(height - 60, 0) }, () => {
        this.measureCategoryOffsets()
      })
    })
  },

  measureCategoryOffsets() {
    if (!this.data.categories.length) {
      this.categoryOffsets = []
      return
    }
    const query = wx.createSelectorQuery().in(this)
    query.select('.dish-scroll').boundingClientRect()
    query.selectAll('.cat-title').boundingClientRect()
    query.exec((res) => {
      const container = res && res[0]
      const titles = (res && res[1]) || []
      if (!container || !titles.length) {
        this.categoryOffsets = []
        return
      }
      this.categoryOffsets = categoryScroll.computeOffsets(
        container.top,
        titles.map((item) => item && item.top),
        this.lastScrollTop
      )
    })
  },

  /** 滚动节流：每 100ms 只比对一次；点击跳转期间暂停反向高亮 */
  onDishScroll(e) {
    this.lastScrollTop = (e.detail && e.detail.scrollTop) || 0
    if (this.suppressSpy || this.spyTimer) return
    this.spyTimer = setTimeout(() => {
      this.spyTimer = null
      this.syncActiveCategory(this.lastScrollTop)
    }, 100)
  },

  syncActiveCategory(scrollTop) {
    const index = categoryScroll.computeActiveIndex(this.categoryOffsets, scrollTop, 12)
    if (index < 0 || index === this.data.activeCategory) return
    this.setData({ activeCategory: index, railScrollIntoView: 'rail-' + index })
  },

  onCategoryTap(e) {
    const index = Number(e.currentTarget.dataset.index)
    const total = this.data.categories.length
    if (!total || index < 0 || index >= total) return
    if (this.spyTimer) {
      clearTimeout(this.spyTimer)
      this.spyTimer = null
    }
    this.suppressSpy = true
    this.setData({ activeCategory: index, railScrollIntoView: 'rail-' + index, scrollIntoView: '' }, () => {
      this.setData({ scrollIntoView: 'cat-' + index })
    })
    if (this.suppressTimer) clearTimeout(this.suppressTimer)
    this.suppressTimer = setTimeout(() => {
      this.suppressSpy = false
      this.syncActiveCategory(this.lastScrollTop)
    }, 700)
  },

  /* 菜品图预览：有图才弹；加载失败给轻提示 */

  onDishImageTap(e) {
    const url = e.currentTarget.dataset.url
    imagePreview.previewDish(url, this.imageFailedUrls || [])
  },

  onDishImageError(e) {
    const url = (e.currentTarget && e.currentTarget.dataset.url) || ''
    if (!url) return
    this.imageFailedUrls = this.imageFailedUrls || []
    if (this.imageFailedUrls.indexOf(url) < 0) this.imageFailedUrls.push(url)
  },

  /** 图片加载会改变标题位置，加载完成后重算一次偏移 */
  onDishImageLoad() {
    if (this.imageMeasureTimer) clearTimeout(this.imageMeasureTimer)
    this.imageMeasureTimer = setTimeout(() => this.measureCategoryOffsets(), 150)
  },

  onUnload() {
    ['measureTimer', 'spyTimer', 'suppressTimer', 'imageMeasureTimer'].forEach((key) => {
      if (this[key]) clearTimeout(this[key])
    })
  },

  copyError() {
    const text = [
      '错误码：' + (this.data.errorCode || 'UNKNOWN'),
      '错误信息：' + (this.data.errorMsg || '（无）'),
      '修复建议：' + (this.data.errorHint || '（无）'),
      '数据模式：' + (this.data.modeLabel || '')
    ].join('\n')
    wx.setClipboardData({ data: text })
  },

  onDishTap(e) {
    const dishId = e.currentTarget.dataset.id
    const dish = this.dishMap[dishId]
    if (!dish) return
    if (dish.soldOut) {
      wx.showToast({ title: '该菜品已售罄', icon: 'none' })
      return
    }
    if (dish.specs && dish.specs.length) {
      this.setData({ pickerVisible: true, pickerDish: dish })
      return
    }
    cartUtil.add({
      dishId: dish._id,
      name: dish.name,
      specOptionIds: [],
      specText: '',
      specDeltaCents: 0,
      unitPriceCents: dish.priceCents,
      imageUrl: dish.imageUrl,
      qty: 1
    })
    this.refreshCart()
    wx.showToast({ title: '已加入购物车', icon: 'none' })
  },

  onPickerClose() {
    this.setData({ pickerVisible: false, pickerDish: null })
  },

  onPickerConfirm(e) {
    const line = e.detail
    cartUtil.add(line)
    this.setData({ pickerVisible: false, pickerDish: null })
    this.refreshCart()
    wx.showToast({ title: '已加入购物车', icon: 'none' })
  },

  /* 底部购物车条 → 购物车清单弹层 */

  openCartSheet() {
    const lines = cartUtil.load()
    if (!lines.length) {
      wx.showToast({ title: '购物车还是空的', icon: 'none' })
      return
    }
    const rows = cartSheet.buildRows(lines, this.dishMap)
    const info = cartSheet.summary(rows)
    this.setData({
      cartSheetVisible: true,
      cartRows: rows,
      cartSheetCount: info.count,
      cartSheetTotalText: info.text
    })
  },

  closeCartSheet() {
    if (!this.data.cartSheetVisible) return
    this.setData({ cartSheetVisible: false })
  },

  /** 遮罩点击关闭；弹层内部点击不关闭 */
  onCartMaskTap() {
    this.closeCartSheet()
  },

  noop() {},

  onCartStep(e) {
    const dataset = (e.currentTarget && e.currentTarget.dataset) || {}
    const delta = Number(dataset.delta) || 0
    const result = cartSheet.stepQty(dataset.key, delta, this.dishMap)
    if (!result.ok) {
      if (result.message) wx.showToast({ title: result.message, icon: 'none' })
      return
    }
    this.refreshCart()
    if (result.removed) {
      const info = cartSheet.summary(cartSheet.buildRows(result.lines, this.dishMap))
      if (info.empty) {
        this.setData({ cartSheetVisible: false })
        wx.showToast({ title: '购物车已清空', icon: 'none' })
      }
    }
  },

  onCartRemove(e) {
    const dataset = (e.currentTarget && e.currentTarget.dataset) || {}
    const list = cartUtil.load().filter((line) => line.key !== dataset.key)
    cartUtil.save(list)
    this.refreshCart()
    if (!list.length) {
      this.setData({ cartSheetVisible: false })
      wx.showToast({ title: '购物车已清空', icon: 'none' })
    }
  },

  /** 结算仍走原有流程（购物车页确认下单） */
  onCartCheckout() {
    if (!cartUtil.load().length) {
      this.setData({ cartSheetVisible: false })
      wx.showToast({ title: '购物车还是空的', icon: 'none' })
      return
    }
    this.setData({ cartSheetVisible: false })
    wx.navigateTo({ url: '/pages/cart/cart' })
  },

  goCart() {
    if (this.data.cartCount === 0) {
      wx.showToast({ title: '购物车还是空的', icon: 'none' })
      return
    }
    wx.navigateTo({ url: '/pages/cart/cart' })
  },

  goOrders() {
    wx.navigateTo({ url: '/pages/orders/orders' })
  },

  goPlatformAdmin() {
    wx.navigateTo({ url: '/pages/platform-admin/index/index' })
  },

  backToBoard() {
    wx.reLaunch({ url: '/pages/merchant/index/index' })
  },

  onShareAppMessage() {
    const firstDish = (this.data.categories[0] && this.data.categories[0].dishes[0]) || null
    const menuTitle = safe.safeText(this.data.menu && this.data.menu.title, '今日菜单')
    const title = this.data.published
      ? `${menuTitle}｜${this.data.dateLabel} 在线点餐`
      : '今日菜单 · 在线点餐'
    return {
      title,
      path: merchantContext.appendMid('/pages/menu/menu'),
      imageUrl: firstDish && firstDish.imageUrl ? firstDish.imageUrl : ''
    }
  }
})
