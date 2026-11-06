const api = require('../../../utils/data-source')
const money = require('../../../utils/money')
const guard = require('../../../utils/merchant-guard')

Page({
  data: {
    loading: true,
    dateLabel: '',
    summary: null,
    totalText: '0.00',
    groups: [],
    orders: [],
    text: '',
    showText: false,
    busy: false
  },

  onShow() {
    guard.requireMerchant().then(() => this.load()).catch(() => {})
  },

  load() {
    this.setData({ loading: true })
    return api
      .call('merchant.packing', {})
      .then((res) => {
        this.setData({
          loading: false,
          dateLabel: res.dateLabel || res.date,
          summary: res,
          totalText: money.formatCents(res.totalCents),
          groups: res.groups || [],
          orders: res.orders || [],
          text: res.text || ''
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        api.showError(err, '打包清单加载失败', { onRetry: () => this.load() })
      })
  },

  togglePacked(e) {
    const orderId = e.currentTarget.dataset.id
    const order = this.data.orders.filter((item) => item.orderId === orderId)[0]
    if (!order || this.data.busy) return
    const packed = !order.packed
    this.setData({ busy: true })
    api
      .call('merchant.setPacked', { orderId, packed })
      .then(() => {
        this.setData({ busy: false })
        this.load()
      })
      .catch((err) => {
        this.setData({ busy: false })
        api.showError(err, '标记打包失败')
        this.load()
      })
  },

  toggleText() {
    this.setData({ showText: !this.data.showText })
  },

  copyText() {
    if (!this.data.text) {
      wx.showToast({ title: '暂无清单内容', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: this.data.text,
      success: () => wx.showToast({ title: '清单已复制，可发群或粘贴打印', icon: 'none' })
    })
  }
})
