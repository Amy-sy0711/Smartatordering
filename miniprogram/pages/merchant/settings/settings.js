const api = require('../../../utils/api')
const image = require('../../../utils/image')

Page({
  data: {
    loading: true,
    payMode: 'transfer',
    modes: [],
    jsapiConfigured: false,
    warning: '',
    transfer: { qrImageUrl: '', payeeName: '', tipText: '' },
    saving: false,
    uploading: false
  },

  onShow() {
    this.load()
  },

  load() {
    this.setData({ loading: true })
    return api
      .call('merchant.getPaymentSettings')
      .then((res) => {
        const settings = res.settings || {}
        this.setData({
          loading: false,
          payMode: settings.payMode || 'transfer',
          modes: res.modes || [],
          jsapiConfigured: res.jsapiConfigured === true,
          warning: res.warning || '',
          transfer: Object.assign({ qrImageUrl: '', payeeName: '', tipText: '' }, settings.transfer || {})
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        api.showError(err, '收款设置加载失败')
      })
  },

  selectMode(e) {
    const value = e.currentTarget.dataset.value
    if (value === 'jsapi' && !this.data.jsapiConfigured) {
      wx.showModal({
        title: '微信支付未配置',
        content: '小程序内微信支付需要在 cloudfunctions/pay/config.js 里配置商户号（SUB_MCH_ID）与云开发环境 ID，并开通 cloudPay。未配置前顾客将无法支付，建议先使用转账收款。',
        confirmText: '仍然选择',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) this.setData({ payMode: value })
        }
      })
      return
    }
    this.setData({ payMode: value })
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    this.setData({ ['transfer.' + field]: e.detail.value })
  },

  chooseQr() {
    if (this.data.uploading) return
    this.setData({ uploading: true })
    image
      .chooseAndUpload('payment')
      .then((fileID) => {
        this.setData({ uploading: false, 'transfer.qrImageUrl': fileID })
      })
      .catch((err) => {
        this.setData({ uploading: false })
        api.showError(err, '收款码上传失败')
      })
  },

  clearQr() {
    this.setData({ 'transfer.qrImageUrl': '' })
  },

  previewQr() {
    const url = this.data.transfer.qrImageUrl
    if (!url) return
    wx.previewImage({ urls: [url], current: url })
  },

  save() {
    if (this.data.saving) return
    const transfer = this.data.transfer
    this.setData({ saving: true })
    api
      .call('merchant.savePaymentSettings', {
        payMode: this.data.payMode,
        transfer: {
          qrImageUrl: String(transfer.qrImageUrl || ''),
          payeeName: String(transfer.payeeName || '').trim(),
          tipText: String(transfer.tipText || '').trim()
        }
      })
      .then((res) => {
        this.setData({
          saving: false,
          warning: res.warning || ''
        })
        wx.showToast({ title: res.warning ? '已保存，但当前方式不可用' : '已保存', icon: 'none' })
        this.load()
      })
      .catch((err) => {
        this.setData({ saving: false })
        api.showError(err, '保存失败')
      })
  }
})
