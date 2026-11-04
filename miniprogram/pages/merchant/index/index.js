const api = require('../../../utils/api')

Page({
  data: {
    loading: true,
    info: null,
    todayStats: null,
    payModeText: '',
    menuPublished: false
  },

  onShow() {
    this.enter()
  },

  enter() {
    api
      .call('merchant.checkAccess', { claim: true })
      .then((info) => {
        this.setData({
          loading: false,
          info,
          payModeText: ''
        })
        return Promise.all([
          api.call('merchant.stats').catch(() => null),
          api.call('merchant.menuDetail').catch(() => null),
          api.call('merchant.getPaymentSettings').catch(() => null)
        ])
      })
      .then((results) => {
        const stats = results[0]
        const menu = results[1]
        const payConfig = results[2]
        this.setData({
          todayStats: stats,
          menuPublished: !!(menu && menu.published),
          payModeText: payConfig ? payConfig.payModeLabel : '—'
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        if (err.code === 'NO_OPENID' || err.code === 'MERCHANT_FORBIDDEN') {
          wx.showModal({
            title: '无商家权限',
            content: err.message || '当前账号不是商家账号',
            showCancel: false,
            success: () => wx.navigateBack({ delta: 1 })
          })
          return
        }
        api.showError(err, '进入商家中心失败')
      })
  },

  copyOpenid() {
    const openid = this.data.info && this.data.info.openid
    if (!openid) return
    wx.setClipboardData({ data: openid })
  },

  goMenu() {
    wx.navigateTo({ url: '/pages/merchant/menu/menu' })
  },

  goBoard() {
    wx.navigateTo({ url: '/pages/merchant/board/board' })
  },

  goPacking() {
    wx.navigateTo({ url: '/pages/merchant/packing/packing' })
  },

  goStats() {
    wx.navigateTo({ url: '/pages/merchant/stats/stats' })
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/merchant/settings/settings' })
  }
})
