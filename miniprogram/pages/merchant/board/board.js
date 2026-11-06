const api = require('../../../utils/data-source')
const statusUtil = require('../../../utils/status')
const guard = require('../../../utils/merchant-guard')

const TABS = [
  { key: 'all', label: '全部', statuses: [] },
  { key: 'pending_confirm', label: '待确认收款', statuses: ['pending_confirm'] },
  { key: 'pending_pay', label: '待付款', statuses: ['pending_pay'] },
  { key: 'paid', label: '待接单', statuses: ['paid'] },
  { key: 'accepted', label: '制作中', statuses: ['accepted'] },
  { key: 'ready', label: '可取餐', statuses: ['ready'] },
  { key: 'completed', label: '已完成', statuses: ['completed'] },
  { key: 'canceled', label: '已取消', statuses: ['canceled'] }
]

Page({
  data: {
    loading: true,
    dateLabel: '',
    orders: [],
    list: [],
    tabs: [],
    activeKey: 'all',
    busy: false
  },

  onShow() {
    guard.requireMerchant().then(() => this.load()).catch(() => {})
  },

  load() {
    this.setData({ loading: true })
    return api
      .call('merchant.orders', {})
      .then((res) => {
        const orders = (res.list || []).map((order) =>
          Object.assign({}, order, { statusTag: statusUtil.tagClass(order.status) })
        )
        const counts = {}
        orders.forEach((order) => {
          counts[order.status] = (counts[order.status] || 0) + 1
        })
        const tabs = TABS.map((tab) => ({
          key: tab.key,
          label: tab.label,
          count: tab.key === 'all' ? orders.length : counts[tab.key] || 0
        }))
        this.setData({ loading: false, dateLabel: res.dateLabel, orders, tabs })
        this.applyFilter(this.data.activeKey)
      })
      .catch((err) => {
        this.setData({ loading: false })
        api.showError(err, '订单加载失败', { onRetry: () => this.load() })
      })
  },

  applyFilter(key) {
    const tab = TABS.filter((item) => item.key === key)[0] || TABS[0]
    const list = tab.statuses.length
      ? this.data.orders.filter((order) => tab.statuses.indexOf(order.status) >= 0)
      : this.data.orders
    this.setData({ activeKey: tab.key, list })
  },

  switchTab(e) {
    this.applyFilter(e.currentTarget.dataset.key)
  },

  openOrder(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/order-detail/order-detail?from=merchant&id=' + encodeURIComponent(id) })
  },

  doAction(e) {
    const action = e.currentTarget.dataset.action
    const orderId = e.currentTarget.dataset.id
    const order = this.data.orders.filter((item) => item.orderId === orderId)[0]
    if (!order || this.data.busy) return

    if (action === 'confirm') {
      wx.showModal({
        title: '确认已收款',
        content: '确认已收到 ¥' + order.totalText + '（订单 #' + order.orderNo + '）？确认后会生成收款记录。',
        success: (res) => {
          if (!res.confirm) return
          this.run(() => api.call('merchant.confirmReceipt', { orderId }), '已确认收款')
        }
      })
      return
    }
    if (action === 'cancel') {
      const tip = order.payChannel === 'transfer' && order.status === 'paid' ? '该订单已收款，取消后会计入退款口径。' : '确定取消该订单吗？'
      wx.showModal({
        title: '取消订单',
        content: tip,
        success: (res) => {
          if (!res.confirm) return
          this.run(() => api.call('merchant.transition', { orderId, action: 'cancel' }), '订单已取消')
        }
      })
      return
    }
    const labels = { accept: '已接单', ready: '已出餐', complete: '订单已完成' }
    this.run(() => api.call('merchant.transition', { orderId, action }), labels[action] || '操作成功')
  },

  run(factory, toastText) {
    this.setData({ busy: true })
    Promise.resolve()
      .then(factory)
      .then(() => {
        this.setData({ busy: false })
        wx.showToast({ title: toastText, icon: 'none' })
        this.load()
      })
      .catch((err) => {
        this.setData({ busy: false })
        api.showError(err)
        this.load()
      })
  }
})
