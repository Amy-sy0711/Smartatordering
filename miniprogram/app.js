const CLOUD_ENV = '' // 云开发环境 ID，例如 'cloud1-xxxx'；留空则使用当前默认环境

App({
  globalData: {
    cloudEnv: CLOUD_ENV,
    isMerchant: false
  },
  onLaunch() {
    if (!wx.cloud) {
      console.error('当前基础库不支持云开发，请使用 2.2.3 及以上版本')
      return
    }
    const options = { traceUser: true }
    if (CLOUD_ENV) options.env = CLOUD_ENV
    wx.cloud.init(options)
  }
})
