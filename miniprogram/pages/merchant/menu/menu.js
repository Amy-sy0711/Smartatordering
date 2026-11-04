const api = require('../../../utils/api')

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
    this.load()
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
        this.setData({
          loading: false,
          dishes,
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
        api.showError(err, '加载失败')
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
        wx.showToast({ title: res.menu && res.menu.slots ? '已发布' : '已发布', icon: 'success' })
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
            wx.showToast({ title: '已删除', icon: 'none' })
            this.load()
          })
          .catch((err) => api.showError(err, '删除失败'))
      }
    })
  }
})
