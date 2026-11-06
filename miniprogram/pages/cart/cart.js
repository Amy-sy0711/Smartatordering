const api = require('../../utils/data-source')
const cartUtil = require('../../utils/cart')
const money = require('../../utils/money')
const payment = require('../../utils/payment')

const MAX_REMARK = 60

Page({
  data: {
    loading: true,
    published: false,
    lines: [],
    count: 0,
    totalCents: 0,
    totalText: '0.00',
    slots: [],
    slotId: '',
    slotLabel: '',
    remark: '',
    maxRemark: MAX_REMARK,
    paySettings: payment.FALLBACK_SETTINGS,
    submitLabel: '提交订单',
    payHint: '',
    payUsable: true,
    invalidCount: 0,
    submitting: false
  },

  onShow() {
    this.load()
  },

  load() {
    const rawLines = cartUtil.load()
    Promise.all([api.call('menu.today'), payment.loadSettings(true)])
      .then((results) => {
        const menu = results[0]
        const settings = results[1]
        const dishMap = {}
        ;(menu.categories || []).forEach((category) => {
          category.dishes.forEach((dish) => {
            dishMap[dish._id] = dish
          })
        })

        const lines = rawLines.map((line) => {
          const dish = dishMap[line.dishId]
          let invalid = ''
          if (!menu.published) invalid = '菜单未发布'
          else if (!dish) invalid = '已下架'
          else if (dish.soldOut) invalid = '已售罄'

          const unitPriceCents = dish ? dish.priceCents : line.unitPriceCents
          const unitCents = unitPriceCents + (line.specDeltaCents || 0)
          return Object.assign({}, line, {
            invalid,
            unitPriceCents,
            unitText: money.formatCents(unitCents),
            lineTotalText: money.formatCents(unitCents * line.qty)
          })
        })

        const totals = cartUtil.totals(lines)
        const slots = (menu.slots || []).map((slot) => ({
          id: slot.id,
          label: slot.label,
          left: slot.left,
          full: slot.full
        }))
        const current = slots.filter((slot) => slot.id === this.data.slotId && !slot.full)[0]
        const firstAvailable = slots.filter((slot) => !slot.full)[0]
        const slotId = current ? current.id : (firstAvailable ? firstAvailable.id : '')
        const slotLabel = (slots.filter((slot) => slot.id === slotId)[0] || {}).label || ''

        this.setData({
          loading: false,
          published: menu.published,
          lines,
          count: totals.count,
          totalCents: totals.cents,
          totalText: totals.text,
          slots,
          slotId,
          slotLabel,
          paySettings: settings,
          submitLabel: payment.submitLabel(settings),
          payHint: payment.modeHint(settings),
          payUsable: settings.usable !== false,
          invalidCount: lines.filter((line) => line.invalid).length
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        api.showError(err, '加载失败')
      })
  },

  selectSlot(e) {
    const id = e.currentTarget.dataset.id
    const slot = this.data.slots.filter((item) => item.id === id)[0]
    if (!slot) return
    if (slot.full) {
      wx.showToast({ title: '该时段已满，请换一个', icon: 'none' })
      return
    }
    this.setData({ slotId: slot.id, slotLabel: slot.label })
  },

  changeQty(e) {
    const key = e.currentTarget.dataset.key
    const delta = Number(e.currentTarget.dataset.delta)
    const lines = this.data.lines
    const line = lines.filter((item) => item.key === key)[0]
    if (!line) return
    const nextQty = line.qty + delta
    if (nextQty <= 0) {
      this.removeLine(e)
      return
    }
    if (nextQty > cartUtil.MAX_QTY) {
      wx.showToast({ title: `单个菜品最多 ${cartUtil.MAX_QTY} 份`, icon: 'none' })
      return
    }
    cartUtil.setQty(key, nextQty)
    const updated = lines.map((item) => {
      if (item.key !== key) return item
      const unitCents = item.unitPriceCents + (item.specDeltaCents || 0)
      return Object.assign({}, item, {
        qty: nextQty,
        lineTotalText: money.formatCents(unitCents * nextQty)
      })
    })
    const totals = cartUtil.totals(updated)
    this.setData({ lines: updated, count: totals.count, totalCents: totals.cents, totalText: totals.text })
  },

  removeLine(e) {
    const key = e.currentTarget.dataset.key
    cartUtil.remove(key)
    this.load()
  },

  clearCart() {
    wx.showModal({
      title: '清空购物车',
      content: '确定要清空所有已选菜品吗？',
      success: (res) => {
        if (!res.confirm) return
        cartUtil.clear()
        this.load()
      }
    })
  },

  onRemarkInput(e) {
    this.setData({ remark: String(e.detail.value || '').slice(0, MAX_REMARK) })
  },

  submit() {
    if (this.data.submitting) return
    if (!this.data.lines.length) {
      wx.showToast({ title: '购物车是空的', icon: 'none' })
      return
    }
    if (this.data.invalidCount > 0) {
      wx.showModal({ title: '有菜品不可售', content: '请先移除已售罄 / 已下架的菜品', showCancel: false })
      return
    }
    if (!this.data.published) {
      wx.showModal({ title: '今日菜单未发布', content: '商家发布菜单后才能下单', showCancel: false })
      return
    }
    if (!this.data.slotId) {
      wx.showToast({ title: '请选择取餐时段', icon: 'none' })
      return
    }
    if (!this.data.payUsable) {
      wx.showModal({
        title: '当前收款方式不可用',
        content: this.data.paySettings.unusableReason || '商家尚未完成支付配置，请联系商家',
        showCancel: false
      })
      return
    }

    this.setData({ submitting: true })
    api
      .call('order.create', {
        cartItems: cartUtil.toServerPayload(this.data.lines),
        slotId: this.data.slotId,
        remark: this.data.remark
      })
      .then((order) => {
        cartUtil.clear()
        wx.redirectTo({
          url: '/pages/order-detail/order-detail?id=' + encodeURIComponent(order.orderId) + '&pay=1'
        })
      })
      .catch((err) => {
        this.setData({ submitting: false })
        api.showError(err, '下单失败')
      })
  }
})
