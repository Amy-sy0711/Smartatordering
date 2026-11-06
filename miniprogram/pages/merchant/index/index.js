const api = require('../../../utils/data-source')
const guard = require('../../../utils/merchant-guard')

Page({
  data: {
    loading: true,
    info: null,
    todayStats: null,
    payModeText: '',
    menuPublished: false,
    modeLabel: '',
    accessError: null
  },

  onShow() {
    this.enter()
  },

  enter() {
    const env = api.getEnvInfo()
    this.setData({ loading: true, accessError: null, modeLabel: env.modeLabel })

    guard
      .requireMerchant()
      .then((info) => {
        this.setData({ loading: false, info: info || null })
        return this.loadDashboard()
      })
      .catch((err) => {
        // 非商家 / 云端不可达：守卫已 toast 并 reLaunch 回菜单页，这里只做日志
        console.error('[merchant.index] 无商家权限', err)
      })
  },

  loadDashboard() {
    return Promise.all([
      api.call('merchant.stats').catch((err) => {
        console.error('[merchant.index] 读取今日收益失败', err)
        return null
      }),
      api.call('merchant.menuDetail').catch((err) => {
        console.error('[merchant.index] 读取今日菜单失败', err)
        return null
      }),
      api.call('merchant.getPaymentSettings').catch((err) => {
        console.error('[merchant.index] 读取收款设置失败', err)
        return null
      })
    ]).then((results) => {
      const stats = results[0]
      const menu = results[1]
      const payConfig = results[2]
      this.setData({
        loading: false,
        todayStats: stats,
        menuPublished: !!(menu && menu.published),
        payModeText: payConfig ? payConfig.payModeLabel : '—'
      })
    })
  },

  retryEnter() {
    this.enter()
  },

  copyOpenid() {
    const openid = (this.data.info && this.data.info.openid) || (this.data.accessError && this.data.accessError.openid)
    if (!openid) {
      wx.showToast({ title: '未获取到 openid', icon: 'none' })
      return
    }
    wx.setClipboardData({ data: openid })
  },

  goDiagnose() {
    wx.navigateTo({ url: '/pages/diagnose/diagnose' })
  },

  goHome() {
    wx.reLaunch({ url: '/pages/menu/menu' })
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
