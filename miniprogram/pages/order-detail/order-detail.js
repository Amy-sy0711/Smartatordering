const api = require('../../utils/data-source')
const statusUtil = require('../../utils/status')

Page({
  data: {
    loading: true,
    order: null,
    fromMerchant: false,
    autoPay: false,
    busy: false,
    actionTextMap: {},
    showPayPanel: false
  },

  onLoad(query) {
    this.orderId = decodeURIComponent((query && query.id) || '')
    this.setData({
      fromMerchant: !!(query && query.from === 'merchant'),
      autoPay: !!(query && query.pay === '1')
    })
    this.load()
  },

  onShow() {
    if (this.loadedOnce) this.load()
  },

  load() {
    if (!this.orderId) {
      this.setData({ loading: false })
      wx.showModal({ title: '订单号缺失', content: '请从订单列表重新进入', showCancel: false })
      return
    }
    return api
      .call('order.detail', { orderId: this.orderId, asMerchant: this.data.fromMerchant === true })
      .then((order) => {
        this.loadedOnce = true
        const actionTextMap = {}
        ;(order.actions || []).forEach((action) => {
          actionTextMap[action] = statusUtil.actionText(action)
        })
        this.setData({
          loading: false,
          order: Object.assign({}, order, { statusTag: statusUtil.tagClass(order.status) }),
          actionTextMap,
          showPayPanel: !order.isMerchant && (order.status === 'pending_pay' || order.status === 'pending_confirm')
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        api.showError(err, '订单加载失败', { onRetry: () => this.load() })
      })
  },

  onPayChanged() {
    this.load()
    setTimeout(() => this.load(), 800)
  },

  copyOrderNo() {
    const orderNo = this.data.order && this.data.order.orderNo
    if (!orderNo) return
    wx.setClipboardData({ data: orderNo })
  },

  runAction(e) {
    const action = e.currentTarget.dataset.action
    const order = this.data.order
    if (!order || this.data.busy) return

    if (action === 'accept' || action === 'ready' || action === 'complete') {
      this.doMerchantTransition(action)
      return
    }
    if (action === 'confirm') {
      wx.showModal({
        title: '确认已收款',
        content: `确认已收到 ¥${order.totalText}（订单 #${order.orderNo}）？确认后将生成收款记录。`,
        success: (res) => {
          if (!res.confirm) return
          this.callWithBusy(() => api.call('merchant.confirmReceipt', { orderId: order.orderId }), '已确认收款')
        }
      })
      return
    }
    if (action === 'cancel') {
      wx.showModal({
        title: '取消订单',
        content: order.refunded ? '该订单已收款，取消后会记为退款口径' : '确定取消这个订单吗？',
        success: (res) => {
          if (!res.confirm) return
          const task = order.isMerchant
            ? api.call('merchant.transition', { orderId: order.orderId, action: 'cancel' })
            : api.call('order.cancel', { orderId: order.orderId })
          this.callWithBusy(() => task, '订单已取消', true)
        }
      })
    }
  },

  doMerchantTransition(action) {
    const order = this.data.order
    const labels = { accept: '已接单', ready: '已出餐', complete: '订单已完成' }
    this.callWithBusy(
      () => api.call('merchant.transition', { orderId: order.orderId, action }),
      labels[action] || '操作成功',
      true
    )
  },

  callWithBusy(taskFactory, toastText, reload) {
    this.setData({ busy: true })
    Promise.resolve()
      .then(taskFactory)
      .then(() => {
        this.setData({ busy: false })
        wx.showToast({ title: toastText, icon: 'none' })
        if (reload !== false) this.load()
      })
      .catch((err) => {
        this.setData({ busy: false })
        api.showError(err)
      })
  },

  goOrders() {
    wx.navigateTo({ url: '/pages/orders/orders' })
  }
})
