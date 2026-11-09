'use strict'

const api = require('../../../utils/api')
const guard = require('../../../utils/platform-guard')

function errText(err) {
  return (err && (err.message || err.errMsg)) || '操作失败'
}

Page({
  data: {
    checking: true,
    needBind: false,
    username: 'admin',
    password: '',
    accessMessage: '',
    accessHint: '',
    merchantId: '',
    list: [],
    loading: false,
    errorText: ''
  },

  onLoad(query) {
    this.setData({ merchantId: String((query && query.merchantId) || '') })
    this.guard()
  },

  guard(payload) {
    this.setData({ checking: true })
    return guard.checkAccess(api, payload).then((decision) => {
      if (decision.allowed) {
        this.setData({ checking: false, needBind: false })
        return this.loadAudit()
      }
      if (decision.needBind) {
        this.setData({ checking: false, needBind: true, accessMessage: decision.message, accessHint: decision.hint })
        return null
      }
      this.setData({ checking: false })
      guard.deny(decision.message)
      return null
    })
  },

  bindSelf() {
    const username = String(this.data.username || '').trim()
    const password = String(this.data.password || '')
    if (!username || !password) {
      wx.showToast({ title: '请填写管理员账号和密码', icon: 'none' })
      return
    }
    this.guard({ username: username, password: password })
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    this.setData({ [field]: e.detail.value })
  },

  loadAudit() {
    this.setData({ loading: true, errorText: '' })
    return api
      .callFn('adminApi', 'audit.list', { limit: 100, merchantId: this.data.merchantId || '' })
      .then((data) => {
        this.setData({ loading: false, list: (data && data.list) || [] })
      })
      .catch((err) => this.setData({ loading: false, errorText: errText(err) }))
  },

  goBack() {
    wx.navigateBack({ delta: 1 })
  }
})
