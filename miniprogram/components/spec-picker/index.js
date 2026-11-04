const money = require('../../utils/money')

Component({
  properties: {
    dish: { type: Object, value: null },
    maxQty: { type: Number, value: 20 }
  },
  data: {
    qty: 1,
    groups: [],
    unitCents: 0,
    unitText: '0.00',
    totalText: '0.00',
    invalidTip: ''
  },
  observers: {
    dish(dish) {
      if (dish) this.build(dish)
    }
  },
  methods: {
    build(dish) {
      const groups = (dish.specs || []).map((group) => {
        const options = (group.options || []).map((option) => ({
          id: option.id,
          label: option.label,
          priceDeltaCents: option.priceDeltaCents || 0,
          deltaText: money.formatDelta(option.priceDeltaCents || 0)
        }))
        const required = group.required !== false
        return {
          id: group.id,
          name: group.name,
          required,
          options,
          selected: required && options.length ? 0 : -1
        }
      })
      this.setData({ groups, qty: 1, invalidTip: '' }, () => this.compute())
    },
    compute() {
      const dish = this.data.dish || {}
      const groups = this.data.groups || []
      let delta = 0
      for (const group of groups) {
        if (group.selected >= 0 && group.options[group.selected]) {
          delta += group.options[group.selected].priceDeltaCents || 0
        }
      }
      const unitCents = (dish.priceCents || 0) + delta
      this.setData({
        unitCents,
        unitText: money.formatCents(unitCents),
        totalText: money.formatCents(unitCents * this.data.qty)
      })
    },
    selectOption(e) {
      const gi = Number(e.currentTarget.dataset.gi)
      const oi = Number(e.currentTarget.dataset.oi)
      const groups = this.data.groups.slice()
      const group = groups[gi]
      if (!group) return
      if (!group.required && group.selected === oi) {
        group.selected = -1
      } else {
        group.selected = oi
      }
      this.setData({ groups, invalidTip: '' }, () => this.compute())
    },
    minus() {
      if (this.data.qty <= 1) return
      this.setData({ qty: this.data.qty - 1 }, () => this.compute())
    },
    plus() {
      if (this.data.qty >= this.data.maxQty) {
        wx.showToast({ title: `单个菜品最多 ${this.data.maxQty} 份`, icon: 'none' })
        return
      }
      this.setData({ qty: this.data.qty + 1 }, () => this.compute())
    },
    close() {
      this.triggerEvent('close')
    },
    stop() {},
    confirm() {
      const dish = this.data.dish
      if (!dish) return
      const groups = this.data.groups || []
      for (const group of groups) {
        if (group.required && group.selected < 0) {
          this.setData({ invalidTip: `请选择「${group.name}」` })
          return
        }
      }
      let specDeltaCents = 0
      const specOptionIds = []
      const labels = []
      for (const group of groups) {
        if (group.selected >= 0 && group.options[group.selected]) {
          const option = group.options[group.selected]
          specDeltaCents += option.priceDeltaCents || 0
          specOptionIds.push(option.id)
          labels.push(option.label)
        }
      }
      this.triggerEvent('confirm', {
        dishId: dish._id,
        name: dish.name,
        qty: this.data.qty,
        specOptionIds,
        specText: labels.join(' / '),
        specDeltaCents,
        unitPriceCents: dish.priceCents,
        imageUrl: dish.imageUrl || ''
      })
    }
  }
})
