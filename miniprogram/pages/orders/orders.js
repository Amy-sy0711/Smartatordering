const api = require('../../utils/api')
const cartUtil = require('../../utils/cart')
const statusUtil = require('../../utils/status')

Page({
  data: {
    loading: true,
    list: [],
    page: 1,
    hasMore: false,
    busy: false
  },

  onShow() {
    this.load(1, false)
  },

  onPullDownRefresh() {
    this.load(1, false).then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh())
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.busy) this.load(this.data.page + 1, true)
  },

  load(page, append) {
    this.setData({ busy: true })
    return api
      .call('order.list', { page })
      .then((res) => {
        const list = (res.list || []).map((item) => Object.assign({}, item, { statusTag: statusUtil.tagClass(item.status) }))
        this.setData({
          loading: false,
          busy: false,
          page,
          hasMore: !!res.hasMore,
          list: append ? this.data.list.concat(list) : list
        })
      })
      .catch((err) => {
        this.setData({ loading: false, busy: false })
        api.showError(err, '订单加载失败')
      })
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/order-detail/order-detail?id=' + encodeURIComponent(id) })
  },

  goMenu() {
    wx.navigateTo({ url: '/pages/menu/menu' })
  },

  reorder(e) {
    const id = e.currentTarget.dataset.id
    if (this.data.busy) return
    this.setData({ busy: true })
    api
      .call('order.reorder', { orderId: id })
      .then((res) => {
        const items = res.items || []
        const available = items.filter((item) => item.available)
        if (!available.length) {
          this.setData({ busy: false })
          wx.showModal({
            title: '无法再来一单',
            content: items.map((item) => `${item.name}：${item.reason || '不可售'}`).join('；') || '今日菜单没有这些菜品',
            showCancel: false
          })
          return
        }
        available.forEach((item) => {
          cartUtil.add({
            dishId: item.dishId,
            name: item.name,
            specOptionIds: item.specOptionIds,
            specText: item.specText,
            specDeltaCents: item.specDeltaCents || 0,
            unitPriceCents: item.priceCents,
            qty: item.qty
          })
        })
        this.setData({ busy: false })
        const skipped = items.length - available.length
        wx.showToast({
          title: skipped ? `已加入购物车，${skipped} 项不可售` : '已加入购物车',
          icon: 'none'
        })
        setTimeout(() => wx.navigateTo({ url: '/pages/cart/cart' }), 600)
      })
      .catch((err) => {
        this.setData({ busy: false })
        api.showError(err, '再来一单失败')
      })
  }
})
