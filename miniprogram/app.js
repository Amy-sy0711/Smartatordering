const dataSource = require('./utils/data-source')
const merchantContext = require('./utils/merchant-context')

const CLOUD_ENV = 'ordering-d0gyct6z1ff2afebd' // 云开发环境 ID，例如 'cloud1-xxxx'；留空则使用当前默认环境
const DATA_MODE = 'cloud' // 'cloud' 走云开发；'local' 仅用于开发调试（管理台/开发配置手动切换）

App({
  globalData: {
    cloudEnv: CLOUD_ENV,
    dataMode: DATA_MODE,
    isMerchant: false,
    merchantId: merchantContext.DEFAULT_MERCHANT_ID
  },
  onLaunch(options) {
    // 分享卡片可能带 mid：冷启动时从 query 捕获当前商家
    merchantContext.capture(options && options.query ? options.query : {})

    let mode = DATA_MODE
    try {
      const saved = wx.getStorageSync(dataSource.MODE_STORAGE_KEY)
      if (saved === dataSource.MODE_LOCAL || saved === dataSource.MODE_CLOUD) mode = saved
    } catch (err) {
      console.warn('[app] 读取数据模式失败', err)
    }
    this.globalData.dataMode = mode

    if (mode === dataSource.MODE_LOCAL) {
      console.log('[app] 本地演示模式（local）：数据保存在本机，不调用云函数')
      return
    }
    if (!dataSource.initCloud({ env: CLOUD_ENV })) {
      console.error('[app] 云开发初始化失败：请检查基础库版本与 CLOUD_ENV')
    }
  }
})
