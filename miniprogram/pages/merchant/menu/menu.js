const api = require('../../../utils/data-source')
const guard = require('../../../utils/merchant-guard')
const menuCache = require('../../../utils/menu-cache')

const DEFAULT_SLOTS = [
  { label: '11:30-12:00', limit: 20 },
  { label: '12:00-12:30', limit: 20 },
  { label: '12:30-13:00', limit: 20 }
]

Page({
  data: {
    loading: true,
    dishes: [],
    menu: { published: false, slots: [], dishIds: [] },
    dateLabel: '',
    editSlots: DEFAULT_SLOTS.slice(),
    menuTitle: '今日菜单',
    history: [],
    showHistory: false,
    showPublish: false,
    publishing: false
  },

  onShow() {
    guard.requireMerchant().then(() => this.load()).catch(() => {})
  },

  load() {
    return Promise.all([
      api.call('merchant.listDishes'),
      api.call('merchant.menuDetail'),
      api.call('merchant.menuHistory').catch(() => ({ list: [] }))
    ])
      .then((results) => {
        const dishes = results[0].list || []
        const menu = results[1] || {}
        const history = (results[2].list || []).filter((item) => !item.isToday)
        const slots = (menu.slots || []).map((slot) => ({ label: slot.label, limit: slot.limit }))
        const todayDishIds = Array.isArray(menu.dishIds) ? menu.dishIds : []
        // 区分「菜品库」与「今日已发布菜单」，避免商家误以为新增菜没生效
        const dishList = dishes.map((dish) => Object.assign({}, dish, {
          inToday: todayDishIds.indexOf(dish._id) >= 0,
          priceText: dish.priceText || '0.00',
          specs: Array.isArray(dish.specs) ? dish.specs : []
        }))
        this.setData({
          loading: false,
          dishes: dishList,
          menu,
          dateLabel: menu.dateLabel || '',
          menuTitle: menu.title || '今日菜单',
          editSlots: slots.length ? slots : DEFAULT_SLOTS.slice(),
          history,
          showPublish: false
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        api.showError(err, '加载失败', { onRetry: () => this.load() })
      })
  },

  togglePublishPanel() {
    this.setData({ showPublish: !this.data.showPublish })
  },

  toggleHistory() {
    this.setData({ showHistory: !this.data.showHistory })
  },

  onTitleInput(e) {
    this.setData({ menuTitle: String(e.detail.value || '') })
  },

  onSlotLabel(e) {
    const index = Number(e.currentTarget.dataset.index)
    const slots = this.data.editSlots.slice()
    slots[index].label = String(e.detail.value || '')
    this.setData({ editSlots: slots })
  },

  onSlotLimit(e) {
    const index = Number(e.currentTarget.dataset.index)
    const slots = this.data.editSlots.slice()
    slots[index].limit = String(e.detail.value || '')
    this.setData({ editSlots: slots })
  },

  addSlot() {
    if (this.data.editSlots.length >= 8) {
      wx.showToast({ title: '最多 8 个时段', icon: 'none' })
      return
    }
    this.setData({ editSlots: this.data.editSlots.concat([{ label: '13:00-13:30', limit: 20 }]) })
  },

  removeSlot(e) {
    const index = Number(e.currentTarget.dataset.index)
    const slots = this.data.editSlots.slice()
    slots.splice(index, 1)
    this.setData({ editSlots: slots })
  },

  publish() {
    if (this.data.publishing) return
    const slots = this.data.editSlots.map((slot) => ({
      label: String(slot.label || '').trim(),
      limit: Number(slot.limit)
    }))
    for (const slot of slots) {
      if (!slot.label) {
        wx.showToast({ title: '时段名称不能为空', icon: 'none' })
        return
      }
      if (!Number.isInteger(slot.limit) || slot.limit < 1) {
        wx.showToast({ title: '时段限量必须是正整数', icon: 'none' })
        return
      }
    }
    const dishIds = this.data.dishes.filter((dish) => dish.onSale).map((dish) => dish._id)
    if (!dishIds.length) {
      wx.showToast({ title: '请先上架至少一个菜品', icon: 'none' })
      return
    }

    this.setData({ publishing: true })
    api
      .call('merchant.publishMenu', { title: this.data.menuTitle, slots, dishIds })
      .then((res) => {
        this.setData({ publishing: false })
        menuCache.invalidate()
        wx.showToast({ title: '已发布，顾客端下拉刷新即可见', icon: 'none' })
        this.load()
      })
      .catch((err) => {
        this.setData({ publishing: false })
        api.showError(err, '发布失败')
      })
  },

  copyFromHistory(e) {
    const fromDate = e.currentTarget.dataset.date
    wx.showModal({
      title: '复制历史菜单',
      content: `用 ${fromDate} 的菜品与取餐时段发布今日菜单？`,
      success: (res) => {
        if (!res.confirm) return
        api
          .call('merchant.copyMenu', { fromDate })
          .then(() => {
            menuCache.invalidate()
            wx.showToast({ title: '已复制并发布', icon: 'none' })
            this.load()
          })
          .catch((err) => api.showError(err, '复制失败'))
      }
    })
  },

  toggleDish(e) {
    const dishId = e.currentTarget.dataset.id
    const field = e.currentTarget.dataset.field
    const value = e.detail.value
    api
      .call('merchant.toggleDish', { dishId, field, value })
      .then(() => {
        menuCache.invalidate()
        const dishes = this.data.dishes.map((dish) => {
          if (dish._id !== dishId) return dish
          const patch = {}
          patch[field] = value
          return Object.assign({}, dish, patch)
        })
        this.setData({ dishes })
      })
      .catch((err) => api.showError(err, '切换失败'))
  },

  addDish() {
    wx.navigateTo({ url: '/pages/merchant/dish/dish' })
  },

  /** 把「菜品库」里的菜加入今日已发布菜单（不再让用户误以为新增菜没生效） */
  addToToday(e) {
    const dishId = e.currentTarget.dataset.id
    if (!dishId) return
    const menu = this.data.menu || {}
    const current = Array.isArray(menu.dishIds) ? menu.dishIds.slice() : []
    if (current.indexOf(dishId) >= 0) {
      wx.showToast({ title: '该菜已在今日菜单中', icon: 'none' })
      return
    }
    const slots = (menu.slots || []).map((slot) => ({ id: slot.id, label: slot.label, limit: slot.limit }))
    api
      .call('merchant.publishMenu', {
        title: this.data.menuTitle,
        slots: slots.length ? slots : DEFAULT_SLOTS,
        dishIds: current.concat([dishId])
      })
      .then(() => {
        menuCache.invalidate()
        wx.showToast({ title: '已加入今日菜单，顾客刷新可见', icon: 'none' })
        this.load()
      })
      .catch((err) => api.showError(err, '加入今日菜单失败'))
  },

  editDish(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/merchant/dish/dish?id=' + encodeURIComponent(id) })
  },

  deleteDish(e) {
    const dishId = e.currentTarget.dataset.id
    const name = e.currentTarget.dataset.name
    wx.showModal({
      title: '删除菜品',
      content: `确定删除「${name}」？今日菜单中也会同步移除。`,
      success: (res) => {
        if (!res.confirm) return
        api
          .call('merchant.deleteDish', { dishId })
          .then(() => {
            menuCache.invalidate()
            wx.showToast({ title: '已删除', icon: 'none' })
            this.load()
          })
          .catch((err) => api.showError(err, '删除失败'))
      }
    })
  }
})
