const api = require('../../utils/api')
const payment = require('../../utils/payment')

Component({
  properties: {
    /** 订单详情对象（来自 order.detail） */
    order: { type: Object, value: null },
    /** 支付配置（来自 settings.payment） */
    settings: { type: Object, value: null }
  },
  data: {
    mode: 'transfer',
    submitting: false,
    jsapiUsable: true
  },
  observers: {
    settings(settings) {
      const value = settings || payment.FALLBACK_SETTINGS
      this.setData({
        mode: value.payMode || 'transfer',
        jsapiUsable: value.usable !== false
      })
    }
  },
  methods: {
    previewQr() {
      const url = (this.data.settings && this.data.settings.transfer && this.data.settings.transfer.qrImageUrl) || ''
      if (!url) return
      wx.previewImage({ urls: [url], current: url })
    },
    submit() {
      const order = this.data.order
      const settings = this.data.settings || payment.FALLBACK_SETTINGS
      if (!order || this.data.submitting) return

      const mode = settings.payMode || 'transfer'
      if (mode === 'jsapi' && settings.usable === false) {
        api.showError(new Error(settings.unusableReason || '微信支付未配置'), '暂时无法支付')
        return
      }

      this.setData({ submitting: true })
      const task = mode === 'transfer'
        ? payment.markTransferred(order.orderId)
        : payment.payViaGateway(order.orderId, mode)

      task
        .then(() => {
          this.setData({ submitting: false })
          wx.showToast({ title: mode === 'transfer' ? '已提交，等待商家确认' : '支付成功', icon: 'none' })
          this.triggerEvent('changed')
        })
        .catch((err) => {
          this.setData({ submitting: false })
          api.showError(err, mode === 'transfer' ? '提交失败' : '支付未完成')
        })
    }
  }
})
