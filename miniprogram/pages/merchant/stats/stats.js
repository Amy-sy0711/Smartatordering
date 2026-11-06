const api = require('../../../utils/data-source')
const money = require('../../../utils/money')
const guard = require('../../../utils/merchant-guard')

Page({
  data: {
    loading: true,
    date: '',
    dateLabel: '',
    stats: null,
    rank: [],
    records: []
  },

  onLoad() {
    guard.requireMerchant().then(() => this.load('')).catch(() => {})
  },

  load(date) {
    this.setData({ loading: true })
    const payload = date ? { date } : {}
    return api
      .call('merchant.stats', payload)
      .then((res) => {
        const rank = (res.dishRank || []).map((item, index) => ({
          rank: index + 1,
          dishId: item.dishId,
          name: item.name,
          qty: item.qty,
          salesText: money.formatCents(item.salesCents || 0)
        }))
        const records = (res.paymentRecords || []).map((record) => ({
          orderNo: record.orderNo,
          amountText: record.amountText,
          channelLabel: record.channelLabel,
          atText: record.atText,
          operator: record.operatorOpenid ? String(record.operatorOpenid).slice(0, 8) + '…' : '—'
        }))
        this.setData({
          loading: false,
          date: res.date,
          dateLabel: res.dateLabel,
          stats: res,
          rank,
          records
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        api.showError(err, '收益统计加载失败', { onRetry: () => this.load(this.data.date || '') })
      })
  },

  onDateChange(e) {
    this.load(e.detail.value)
  },

  backToToday() {
    this.load('')
  }
})
