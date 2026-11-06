const api = require('../../utils/data-source')
const roleRouter = require('../../utils/role-router')
const merchantContext = require('../../utils/merchant-context')

Page({
  data: {
    status: '正在识别身份…'
  },

  onLoad(options) {
    merchantContext.capture(options)
    this.route()
  },

  route() {
    const app = getApp()
    if (app && app.globalData) {
      app.globalData.identity = null
      app.globalData.identityError = null
    }
    this.setData({ status: '正在识别身份…' })

    api
      .whoami()
      .then((info) => {
        if (app && app.globalData) app.globalData.identity = info || null
        const decision = roleRouter.resolveStartRoute(info)
        wx.reLaunch({ url: decision.target })
      })
      .catch((err) => {
        console.error('[entry] 身份识别失败', err)
        const info = api.describeError(err)
        if (app && app.globalData) app.globalData.identityError = info
        const decision = roleRouter.resolveStartRoute({ error: info })
        wx.reLaunch({ url: decision.target })
      })
  }
})
