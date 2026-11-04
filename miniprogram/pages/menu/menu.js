const api = require('../../utils/api')
const cartUtil = require('../../utils/cart')
const payment = require('../../utils/payment')

Page({
  data: {
    loading: true,
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
    pickerVisible: false,
    pickerDish: null
  },

  onLoad() {
    this.dishMap = {}
    this.refresh(true)
  },

  onShow() {
    this.refreshCart()
  },

  onPullDownRefresh() {
    this.refresh(false).then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh())
  },

  refresh(showLoading) {
    if (showLoading !== false) wx.showLoading({ title: '加载菜单', mask: true })
    return Promise.all([
      api.call('menu.today'),
      api.call('merchant.checkAccess').catch(() => ({ isMerchant: false, canBootstrap: false }))
    ])
      .then((results) => {
        const menu = results[0]
        const access = results[1] || {}
        const dishMap = {}
        const categories = (menu.categories || []).map((category) => ({
          name: category.name,
          dishes: category.dishes.map((dish) => {
            dishMap[dish._id] = dish
            return dish
          })
        }))
        this.dishMap = dishMap
        this.setData({
          loading: false,
          published: menu.published,
          menu: { title: menu.title, dateLabel: menu.dateLabel, date: menu.date },
          categories,
          slots: menu.slots || [],
          totalDishes: menu.totalDishes || 0,
          dateLabel: menu.dateLabel,
          shop: menu.shop,
          paySettings: menu.payment || payment.FALLBACK_SETTINGS,
          isMerchant: !!access.isMerchant,
          canBootstrap: !!access.canBootstrap && !access.isMerchant
        })
        this.refreshCart()
      })
      .catch((err) => {
        this.setData({ loading: false })
        api.showError(err, '菜单加载失败')
      })
      .then(() => {
        if (showLoading !== false) wx.hideLoading()
      })
  },

  refreshCart() {
    const totals = cartUtil.totals(cartUtil.load())
    this.setData({ cartCount: totals.count, cartTotalText: totals.text })
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

  goMerchant() {
    wx.navigateTo({ url: '/pages/merchant/index/index' })
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
