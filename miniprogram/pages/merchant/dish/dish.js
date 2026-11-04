const api = require('../../../utils/api')
const money = require('../../../utils/money')
const image = require('../../../utils/image')

function emptyForm() {
  return {
    name: '',
    category: '盖饭',
    priceYuan: '',
    imageUrl: '',
    sortOrder: '0',
    onSale: true,
    soldOut: false
  }
}

Page({
  data: {
    loading: false,
    dishId: '',
    form: emptyForm(),
    specs: [],
    categories: ['盖饭', '面食', '小食', '饮品', '其他'],
    saving: false,
    uploading: false
  },

  onLoad(query) {
    const dishId = decodeURIComponent((query && query.id) || '')
    this.setData({ dishId })
    if (dishId) this.loadDish(dishId)
  },

  loadDish(dishId) {
    this.setData({ loading: true })
    api
      .call('merchant.listDishes')
      .then((res) => {
        const dish = (res.list || []).filter((item) => item._id === dishId)[0]
        if (!dish) throw new Error('菜品不存在或已被删除')
        this.setData({
          loading: false,
          form: {
            name: dish.name,
            category: dish.category || '其他',
            priceYuan: money.formatCents(dish.priceCents),
            imageUrl: dish.imageUrl || '',
            sortOrder: String(dish.sortOrder || 0),
            onSale: dish.onSale !== false,
            soldOut: dish.soldOut === true
          },
          specs: (dish.specs || []).map((group) => ({
            name: group.name,
            required: group.required !== false,
            options: (group.options || []).map((option) => ({
              label: option.label,
              deltaYuan: money.formatCents(option.priceDeltaCents || 0)
            }))
          }))
        })
      })
      .catch((err) => {
        this.setData({ loading: false })
        api.showError(err, '菜品加载失败')
      })
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    this.setData({ ['form.' + field]: e.detail.value })
  },

  onSwitch(e) {
    const field = e.currentTarget.dataset.field
    if (!field) return
    this.setData({ ['form.' + field]: e.detail.value === true })
  },

  pickCategory(e) {
    this.setData({ 'form.category': e.currentTarget.dataset.value })
  },

  chooseImage() {
    if (this.data.uploading) return
    this.setData({ uploading: true })
    image
      .chooseAndUpload('dishes')
      .then((fileID) => {
        this.setData({ uploading: false, 'form.imageUrl': fileID })
      })
      .catch((err) => {
        this.setData({ uploading: false })
        api.showError(err, '图片上传失败')
      })
  },

  clearImage() {
    this.setData({ 'form.imageUrl': '' })
  },

  addSpecGroup() {
    if (this.data.specs.length >= 5) {
      wx.showToast({ title: '最多 5 组规格', icon: 'none' })
      return
    }
    this.setData({
      specs: this.data.specs.concat([
        { name: '', required: true, options: [{ label: '', deltaYuan: '0' }] }
      ])
    })
  },

  removeSpecGroup(e) {
    const gi = Number(e.currentTarget.dataset.gi)
    const specs = this.data.specs.slice()
    specs.splice(gi, 1)
    this.setData({ specs })
  },

  onGroupName(e) {
    const gi = Number(e.currentTarget.dataset.gi)
    this.setData({ ['specs[' + gi + '].name']: e.detail.value })
  },

  onGroupRequired(e) {
    const gi = Number(e.currentTarget.dataset.gi)
    this.setData({ ['specs[' + gi + '].required']: e.detail.value === true })
  },

  addOption(e) {
    const gi = Number(e.currentTarget.dataset.gi)
    const specs = this.data.specs.slice()
    if (specs[gi].options.length >= 10) {
      wx.showToast({ title: '每组最多 10 个选项', icon: 'none' })
      return
    }
    specs[gi].options = specs[gi].options.concat([{ label: '', deltaYuan: '0' }])
    this.setData({ specs })
  },

  removeOption(e) {
    const gi = Number(e.currentTarget.dataset.gi)
    const oi = Number(e.currentTarget.dataset.oi)
    const specs = this.data.specs.slice()
    specs[gi].options.splice(oi, 1)
    if (!specs[gi].options.length) specs[gi].options = [{ label: '', deltaYuan: '0' }]
    this.setData({ specs })
  },

  onOptionLabel(e) {
    const gi = Number(e.currentTarget.dataset.gi)
    const oi = Number(e.currentTarget.dataset.oi)
    this.setData({ ['specs[' + gi + '].options[' + oi + '].label']: e.detail.value })
  },

  onOptionDelta(e) {
    const gi = Number(e.currentTarget.dataset.gi)
    const oi = Number(e.currentTarget.dataset.oi)
    this.setData({ ['specs[' + gi + '].options[' + oi + '].deltaYuan']: e.detail.value })
  },

  buildSpecs() {
    const result = []
    for (const group of this.data.specs) {
      const name = String(group.name || '').trim()
      if (!name) return { error: '规格组名称不能为空' }
      const options = []
      for (const option of group.options) {
        const label = String(option.label || '').trim()
        if (!label) continue
        const deltaCents = money.parseYuanToCents(option.deltaYuan === '' ? '0' : option.deltaYuan)
        if (deltaCents === null) return { error: '规格「' + label + '」加价格式不正确' }
        options.push({ label, priceDeltaCents: deltaCents })
      }
      if (!options.length) return { error: '规格组「' + name + '」至少需要一个选项' }
      result.push({ name, required: group.required !== false, options })
    }
    return { specs: result }
  },

  save() {
    if (this.data.saving) return
    const form = this.data.form
    const name = String(form.name || '').trim()
    if (!name) {
      wx.showToast({ title: '请填写菜品名称', icon: 'none' })
      return
    }
    const priceCents = money.parseYuanToCents(form.priceYuan)
    if (priceCents === null) {
      wx.showToast({ title: '价格格式不正确（如 12.50）', icon: 'none' })
      return
    }
    const built = this.buildSpecs()
    if (built.error) {
      wx.showToast({ title: built.error, icon: 'none' })
      return
    }
    const sortOrder = Number(form.sortOrder)
    if (!Number.isInteger(sortOrder)) {
      wx.showToast({ title: '排序值必须是整数', icon: 'none' })
      return
    }

    this.setData({ saving: true })
    api
      .call('merchant.saveDish', {
        dishId: this.data.dishId,
        dish: {
          name,
          category: String(form.category || '其他').trim() || '其他',
          priceCents,
          imageUrl: String(form.imageUrl || ''),
          sortOrder,
          onSale: form.onSale !== false,
          soldOut: form.soldOut === true,
          specs: built.specs
        }
      })
      .then(() => {
        this.setData({ saving: false })
        wx.showToast({ title: '已保存', icon: 'success' })
        setTimeout(() => wx.navigateBack({ delta: 1 }), 600)
      })
      .catch((err) => {
        this.setData({ saving: false })
        api.showError(err, '保存失败')
      })
  }
})
