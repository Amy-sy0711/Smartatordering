const api = require('../../utils/data-source')
const cartUtil = require('../../utils/cart')
const payment = require('../../utils/payment')
const safe = require('../../utils/safe')

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
    isMerchant: false,
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
    pickerDish: null
  },

  onLoad(options) {
    this.dishMap = {}
    this.setData({ fromMerchant: options && options.from === 'merchant' })
    const app = getApp()
    const globalData = (app && app.globalData) || {}
    this.setData({
      identity: globalData.identity || null,
      identityError: globalData.identityError || null
    })
    this.refresh(true)
  },

  onShow() {
    this.refreshCart()
  },

  onPullDownRefresh() {
    this.refresh(false).then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh())
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
            full: !!src.full
          }
        })
        this.dishMap = dishMap
        this.setData({
          loading: false,
          loadState: menu.published ? 'ready' : 'empty',
          published: !!menu.published,
          menu: {
            title: safe.safeText(menu.title, '今日菜单'),
            dateLabel: safe.safeText(menu.dateLabel, ''),
            date: safe.safeText(menu.date, '')
          },
          categories,
          slots,
          totalDishes: safe.safeInt(menu.totalDishes, 0),
          dateLabel: safe.safeText(menu.dateLabel, ''),
          shop: menu.shop || null,
          paySettings: menu.payment || payment.FALLBACK_SETTINGS,
          isMerchant: !!access.isMerchant,
          canBootstrap: false,
          errorCode: '',
          errorMsg: '',
          errorHint: ''
        })
        this.refreshCart()
      })
      .catch((err) => {
        // 云端/本地调用失败：不静默吞掉，页面展示可复制的错误信息
        console.error('[menu] 菜单加载失败', err)
        const info = api.describeError(err)
        this.setData({
          loading: false,
          loadState: 'load_failed',
          published: false,
          isMerchant: false,
          canBootstrap: false,
          errorCode: info.code,
          errorMsg: info.message,
          errorHint: info.hint,
          modeLabel: info.modeLabel,
          isLocal: info.mode === api.MODE_LOCAL
        })
      })
      .then(() => {
        if (showLoading !== false) wx.hideLoading()
      })
  },

  refreshCart() {
    const totals = cartUtil.totals(cartUtil.load())
    this.setData({ cartCount: totals.count, cartTotalText: totals.text })
  },

  retry() {
    this.refresh(true)
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

  goDiagnose() {
    wx.navigateTo({ url: '/pages/diagnose/diagnose' })
  },

  useLocalDemo() {
    api.switchToLocal()
  },

  useCloudMode() {
    api.switchToCloud()
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

  backToBoard() {
    wx.reLaunch({ url: '/pages/merchant/index/index' })
  },

  onShareAppMessage() {
    const firstDish = (this.data.categories[0] && this.data.categories[0].dishes[0]) || null
    const title = this.data.published
      ? `${this.data.menu.title}｜${this.data.dateLabel} 在线点餐`
      : '今日菜单 · 在线点餐'
    return {
      title,
      path: '/pages/menu/menu',
      imageUrl: firstDish && firstDish.imageUrl ? firstDish.imageUrl : ''
    }
  }
})
