const api = require('../../../utils/data-source')
const money = require('../../../utils/money')
const image = require('../../../utils/image')
const guard = require('../../../utils/merchant-guard')
const menuCache = require('../../../utils/menu-cache')
const safe = require('../../../utils/safe')

function emptyForm() {
  return {
    name: '',
    category: '其他',
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
    categories: ['其他'],
    newCategoryName: '',
    categorySaving: false,
    saving: false,
    uploading: false
  },

  onLoad(query) {
    const dishId = decodeURIComponent((query && query.id) || '')
    guard
      .requireMerchant()
      .then(() => {
        this.setData({ dishId })
        this.loadCategories()
        if (dishId) this.loadDish(dishId)
      })
      .catch(() => {})
  },

  loadCategories() {
    return api
      .call('merchant.listCategories')
      .then((res) => {
        const names = safe
          .safeArray(res && res.list)
          .filter((item) => item && item.enabled !== false)
          .map((item) => safe.safeText(item.name, ''))
          .filter((name, index, arr) => name && arr.indexOf(name) === index)
        if (!names.length) names.push('其他')
        const current = this.data.form.category
        if (current && names.indexOf(current) < 0) names.push(current)
        this.setData({ categories: names })
      })
      .catch(() => {
        this.setData({ categories: ['其他'] })
      })
  },

  onNewCategoryInput(e) {
    this.setData({ newCategoryName: String(e.detail.value || '') })
  },

  addCategoryInline() {
    if (this.data.categorySaving) return
    const name = String(this.data.newCategoryName || '').trim()
    if (!name) {
      wx.showToast({ title: '请填写分类名称', icon: 'none' })
      return
    }
    this.setData({ categorySaving: true })
    api
      .call('merchant.saveCategory', { name })
      .then(() => {
        const categories = this.data.categories.slice()
        if (categories.indexOf(name) < 0) categories.push(name)
        this.setData({ categorySaving: false, newCategoryName: '', categories, 'form.category': name })
        menuCache.invalidate()
        wx.showToast({ title: '已新增分类', icon: 'none' })
      })
      .catch((err) => {
        this.setData({ categorySaving: false })
        api.showError(err, '新增分类失败')
      })
  },

  loadDish(dishId) {
    this.setData({ loading: true })
    api
      .call('merchant.listDishes')
      .then((res) => {
        const dish = (res.list || []).filter((item) => item._id === dishId)[0]
        if (!dish) throw new Error('菜品不存在或已被删除')
        const category = safe.safeText(dish.category, '其他')
        const categories = this.data.categories.slice()
        if (categories.indexOf(category) < 0) categories.push(category)
        this.setData({
          loading: false,
          categories,
          form: {
            name: safe.safeText(dish.name, '').slice(0, 20),
            category,
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
        menuCache.invalidate()
        wx.showToast({ title: '已保存', icon: 'success' })
        setTimeout(() => wx.navigateBack({ delta: 1 }), 600)
      })
      .catch((err) => {
        this.setData({ saving: false })
        api.showError(err, '保存失败')
      })
  }
})
