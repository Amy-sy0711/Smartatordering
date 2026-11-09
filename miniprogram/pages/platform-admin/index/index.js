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
    openid: '',
    loading: false,
    merchants: [],
    search: '',
    statusFilter: '',
    errorText: '',
    createVisible: false,
    createForm: { name: '', merchantId: '', contact: '' },
    editor: null,
    staff: null
  },
  onLoad() {
    this.guard()
  },

  onPullDownRefresh() {
    this.loadMerchants().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh())
  },

  guard(payload) {
    this.setData({ checking: true, errorText: '' })
    return guard.checkAccess(api, payload).then((decision) => {
      if (decision.allowed) {
        this.setData({ checking: false, needBind: false, accessMessage: '', accessHint: '' })
        return this.loadMerchants()
      }
      if (decision.needBind) {
        this.setData({ checking: false, needBind: true, accessMessage: decision.message, accessHint: decision.hint })
        return null
      }
      this.setData({ checking: false, needBind: false })
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
    this.setData({ checking: true })
    this.guard({ username: username, password: password }).then(() => {
      if (this.data.needBind) wx.showToast({ title: '绑定失败，请核对账号密码', icon: 'none' })
    })
  },

  onField(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    this.setData({ [field]: e.detail.value })
  },

  loadMerchants() {
    this.setData({ loading: true, errorText: '' })
    return api
      .callFn('adminApi', 'merchant.list', { search: String(this.data.search || '').trim(), status: this.data.statusFilter })
      .then((data) => this.setData({ loading: false, merchants: (data && data.list) || [] }))
      .catch((err) => this.setData({ loading: false, errorText: errText(err) }))
  },

  onSearch(e) {
    this.setData({ search: e.detail.value })
  },

  searchNow() {
    this.loadMerchants()
  },

  setFilter(e) {
    this.setData({ statusFilter: e.currentTarget.dataset.status || '' })
    this.loadMerchants()
  },

  toggleCreate() {
    this.setData({ createVisible: !this.data.createVisible })
  },

  createMerchant() {
    const form = this.data.createForm || {}
    if (!String(form.name || '').trim()) {
      wx.showToast({ title: '请填写商家名称', icon: 'none' })
      return
    }
    api
      .callFn('adminApi', 'merchant.create', {
        name: String(form.name || '').trim(),
        merchantId: String(form.merchantId || '').trim(),
        contact: String(form.contact || '').trim()
      })
      .then((data) => {
        wx.showModal({
          title: '商家已创建',
          content:
            '商家 ID：' + (data.merchantId || '') +
            '\n登录账号：' + (data.loginUsername || '') +
            '\n初始密码：' + (data.initialPassword || '') +
            '\n\n初始密码只显示这一次，请立即记录。',
          showCancel: false,
          confirmText: '已记录'
        })
        this.setData({ createVisible: false, createForm: { name: '', merchantId: '', contact: '' } })
        return this.loadMerchants()
      })
      .catch((err) => wx.showModal({ title: '创建失败', content: errText(err), showCancel: false }))
  },
  openEditor(e) {
    const merchantId = e.currentTarget.dataset.id
    const item = (this.data.merchants || []).filter((m) => m.merchantId === merchantId)[0]
    if (!item) return
    const flags = item.flags || {}
    this.setData({
      staff: null,
      editor: {
        merchantId: merchantId,
        name: item.name || '',
        contact: item.contact || '',
        plan: item.plan || 'basic',
        expiresAt: item.expiresAt || '',
        status: item.status === 'disabled' ? 'disabled' : 'active',
        disableOrdering: !!flags.disableOrdering,
        pickupOnly: !!flags.pickupOnly,
        maxConcurrentOrders: Number(flags.maxConcurrentOrders) || 0
      }
    })
  },

  closeEditor() {
    this.setData({ editor: null })
  },

  onEditorCheck(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    this.setData({ [field]: !!e.detail.value })
  },

  saveEditor() {
    const editor = this.data.editor
    if (!editor) return
    const merchantId = editor.merchantId
    api
      .callFn('adminApi', 'merchant.update', {
        merchantId: merchantId,
        name: String(editor.name || '').trim(),
        contact: String(editor.contact || '').trim(),
        plan: String(editor.plan || '').trim() || 'basic',
        expiresAt: String(editor.expiresAt || '').trim() || null,
        status: editor.status
      })
      .then(() =>
        api.callFn('adminApi', 'merchant.setFlags', {
          merchantId: merchantId,
          flags: {
            disableOrdering: !!editor.disableOrdering,
            pickupOnly: !!editor.pickupOnly,
            maxConcurrentOrders: Number(editor.maxConcurrentOrders) || 0
          }
        })
      )
      .then(() => {
        wx.showToast({ title: '已保存', icon: 'success' })
        this.setData({ editor: null })
        return this.loadMerchants()
      })
      .catch((err) => wx.showModal({ title: '保存失败', content: errText(err), showCancel: false }))
  },

  toggleStatus(e) {
    const merchantId = e.currentTarget.dataset.id
    const item = (this.data.merchants || []).filter((m) => m.merchantId === merchantId)[0]
    if (!item) return
    const next = item.status === 'disabled' ? 'active' : 'disabled'
    wx.showModal({
      title: next === 'disabled' ? '停用商家' : '启用商家',
      content: '确认' + (next === 'disabled' ? '停用 ' : '启用 ') + merchantId + '？',
      success: (res) => {
        if (!res.confirm) return
        api
          .callFn('adminApi', 'merchant.setStatus', { merchantId: merchantId, status: next })
          .then(() => this.loadMerchants())
          .catch((err) => wx.showModal({ title: '操作失败', content: errText(err), showCancel: false }))
      }
    })
  },

  openStaff(e) {
    const merchantId = e.currentTarget.dataset.id
    this.setData({ editor: null, staff: { merchantId: merchantId, list: [], openid: '', role: 'staff', name: '' } })
    this.loadStaff()
  },

  closeStaff() {
    this.setData({ staff: null })
  },

  onStaffField(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    this.setData({ [field]: e.detail.value })
  },

  loadStaff() {
    const staff = this.data.staff
    if (!staff) return
    api
      .callFn('adminApi', 'staff.list', { merchantId: staff.merchantId })
      .then((data) => this.setData({ 'staff.list': (data && data.list) || [] }))
      .catch((err) => wx.showModal({ title: '读取员工失败', content: errText(err), showCancel: false }))
  },

  bindStaff() {
    const staff = this.data.staff
    if (!staff) return
    const openid = String(staff.openid || '').trim()
    if (!openid) {
      wx.showToast({ title: '请填写 openid', icon: 'none' })
      return
    }
    api
      .callFn('adminApi', 'staff.bind', {
        merchantId: staff.merchantId,
        openid: openid,
        role: staff.role || 'staff',
        name: String(staff.name || '').trim()
      })
      .then(() => {
        this.setData({ 'staff.openid': '', 'staff.name': '' })
        this.loadStaff()
        this.loadMerchants()
      })
      .catch((err) => wx.showModal({ title: '绑定失败', content: errText(err), showCancel: false }))
  },

  unbindStaff(e) {
    const staff = this.data.staff
    const openid = e.currentTarget.dataset.openid
    if (!staff || !openid) return
    wx.showModal({
      title: '解绑员工',
      content: '确认解绑 ' + openid + '？',
      success: (res) => {
        if (!res.confirm) return
        api
          .callFn('adminApi', 'staff.unbind', { merchantId: staff.merchantId, openid: openid })
          .then(() => {
            this.loadStaff()
            this.loadMerchants()
          })
          .catch((err) => wx.showModal({ title: '解绑失败', content: errText(err), showCancel: false }))
      }
    })
  },

  goDetail(e) {
    const merchantId = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/platform-admin/detail/detail?merchantId=' + encodeURIComponent(merchantId) })
  },

  goAudit() {
    wx.navigateTo({ url: '/pages/platform-admin/audit/audit' })
  },

  goHome() {
    wx.reLaunch({ url: guard.MENU_PATH })
  },

  copyOpenid() {
    if (!this.data.openid) {
      wx.showToast({ title: '暂未获取到 openid', icon: 'none' })
      return
    }
    wx.setClipboardData({ data: this.data.openid })
  }
})
