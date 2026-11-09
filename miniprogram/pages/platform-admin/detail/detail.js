'use strict'

const api = require('../../../utils/api')
const guard = require('../../../utils/platform-guard')

function errText(err) {
  return (err && (err.message || err.errMsg)) || '操作失败'
}

Page({
  data: {
    merchantId: '',
    checking: true,
    needBind: false,
    username: 'admin',
    password: '',
    accessMessage: '',
    accessHint: '',
    health: null,
    staff: [],
    flags: [],
    errorText: '',
    busy: false
  },

  onLoad(query) {
    const merchantId = String((query && query.merchantId) || '')
    this.setData({ merchantId: merchantId })
    this.guard()
  },

  guard(payload) {
    this.setData({ checking: true })
    return guard.checkAccess(api, payload).then((decision) => {
      if (decision.allowed) {
        this.setData({ checking: false, needBind: false })
        return this.loadAll()
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

  loadAll() {
    const merchantId = this.data.merchantId
    if (!merchantId) {
      this.setData({ errorText: '缺少 merchantId 参数' })
      return Promise.resolve()
    }
    this.setData({ busy: true, errorText: '' })
    return api
      .callFn('adminApi', 'health', { merchantId: merchantId })
      .then((data) => {
        const flags = Object.keys((data && data.merchant && data.merchant.flags) || {}).map((key) => ({
          key: key,
          value: String(data.merchant.flags[key])
        }))
        this.setData({ health: data, flags: flags })
        return api.callFn('adminApi', 'staff.list', { merchantId: merchantId })
      })
      .then((data) => this.setData({ busy: false, staff: (data && data.list) || [] }))
      .catch((err) => this.setData({ busy: false, errorText: errText(err) }))
  },

  repair(e) {
    const action = e.currentTarget.dataset.action
    if (!action) return
    wx.showModal({
      title: '执行修复动作',
      content: '确认执行 ' + action + '（商家 ' + this.data.merchantId + '）？',
      success: (res) => {
        if (!res.confirm) return
        this.setData({ busy: true })
        api
          .callFn('adminApi', action, { merchantId: this.data.merchantId })
          .then(() => {
            wx.showToast({ title: '已执行', icon: 'success' })
            this.setData({ busy: false })
            this.loadAll()
          })
          .catch((err) => {
            this.setData({ busy: false })
            wx.showModal({ title: '执行失败', content: errText(err), showCancel: false })
          })
      }
    })
  },

  goAudit() {
    wx.navigateTo({ url: '/pages/platform-admin/audit/audit?merchantId=' + encodeURIComponent(this.data.merchantId) })
  },

  goBack() {
    wx.navigateBack({ delta: 1 })
  }
})
