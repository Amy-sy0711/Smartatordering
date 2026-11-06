const api = require('../../utils/data-source')

function check(key, title, status, detail, fix) {
  return { key, title, status, statusText: statusLabel(status), detail, fix }
}

function buildClientChecks(env) {
  const checks = []
  checks.push(
    check(
      'mode',
      '当前数据模式',
      env.isLocal ? 'warn' : 'pass',
      env.modeLabel + (env.isLocal ? '（数据只保存在本机，不调用云函数）' : ''),
      env.isLocal ? '如果要验证云端，请点下方「切换到云端模式」并重新自检' : '无需处理'
    )
  )
  checks.push(
    check(
      'cloud-sdk',
      'wx.cloud / callFunction 是否可用',
      env.hasCloud ? 'pass' : 'fail',
      env.hasCloud ? '当前基础库支持云开发' : '当前基础库不支持 wx.cloud',
      env.hasCloud ? '无需处理' : '微信开发者工具 → 详情 → 本地设置 → 调试基础库调到 2.2.3 及以上，并使用小程序模式'
    )
  )
  checks.push(
    check(
      'cloud-env',
      'CLOUD_ENV 配置',
      env.envStatus.ok ? 'pass' : 'fail',
      env.envStatus.ok ? '已配置：' + env.cloudEnv : env.envStatus.message + (env.cloudEnv ? '：' + env.cloudEnv : ''),
      env.envStatus.ok ? '无需处理' : '打开 miniprogram/app.js，把 CLOUD_ENV 改成云开发控制台里的环境 ID（当前应为 ordering-d0gyct6z1ff2afebd）'
    )
  )
  checks.push(
    check(
      'cloud-function-name',
      '云函数名称与目录一致',
      'pass',
      '代码调用 wx.cloud.callFunction({ name: "api" })，对应目录 cloudfunctions/api',
      '若改名过云函数，请同步修改 utils/api.js 里的 FUNCTIONS 常量并重新部署'
    )
  )
  return checks
}

function buildServerChecks(data) {
  const checks = []
  const isLocal = data && data.mode === 'local'
  const identity = (data && data.identity) || {}
  checks.push(
    check(
      'identity-openid',
      '我的 openid',
      identity.openid ? 'pass' : 'fail',
      identity.openid
        ? identity.openid
        : '未获取到 openid（请在小程序模式运行，不要用「游客」或网页模式）',
      identity.openid
        ? '复制后加入 merchant_admins.openids 数组，或写入 cloudfunctions/api/config.js 的 MERCHANT_OPENIDS'
        : '重新编译并以小程序模式打开；若仍为空，先部署 api 云函数'
    )
  )
  checks.push(
    check(
      'identity-role',
      '是否商家',
      identity.isMerchant ? 'pass' : 'warn',
      identity.isMerchant ? '是商家，启动后会自动进入商家订单看板' : '当前不是商家，启动后进入顾客端菜单',
      identity.isMerchant
        ? '无需处理'
        : '把上面的 openid 加入 merchant_admins 集合的 openids 数组，重新编译后再自检'
    )
  )
  checks.push(
    check(
      'api',
      isLocal ? '本地数据后端' : '云函数 api 可达性',
      'pass',
      isLocal
        ? '本地演示后端可用（storage 持久化）'
        : '云函数调用成功，环境 ID：' + (data.envId || '（未返回）') + '，服务器时间：' + (data.serverTimeText || ''),
      '无需处理'
    )
  )

  const collections = (data && data.collections) || []
  for (const item of collections) {
    checks.push(
      check(
        'collection-' + item.name,
        '集合 ' + item.name + '（' + (item.label || '') + '）',
        item.exists ? 'pass' : 'fail',
        item.exists ? '存在，文档数：' + item.total : (item.error || '不存在'),
        item.fix || (item.exists ? '无需处理' : '执行 init 云函数 {"action":"setup"} 或手动新建集合')
      )
    )
  }

  const today = (data && data.today) || {}
  checks.push(
    check(
      'menu-today',
      '今日菜单是否已发布',
      today.menuPublished ? 'pass' : 'fail',
      today.menuPublished
        ? '已发布：' + (today.menuTitle || '') + '（' + (today.dishCount || 0) + ' 个菜）'
        : '今日（' + (today.dateLabel || '') + '）尚未发布菜单',
      today.fix || (today.menuPublished ? '无需处理' : '商家看板 → 菜单管理 → 发布今日菜单')
    )
  )

  const payment = (data && data.payment) || {}
  checks.push(
    check(
      'payment',
      '收款方式是否可用',
      payment.usable ? 'pass' : 'warn',
      (payment.payModeLabel || payment.payMode || '未知') + (payment.usable ? '' : '：' + (payment.unusableReason || '不可用')),
      payment.fix || (payment.usable ? '无需处理' : '商家端 → 收款设置 → 切回转账 transfer')
    )
  )
  return checks
}

function summarize(checks) {
  let pass = 0
  let fail = 0
  let warn = 0
  for (const item of checks) {
    if (item.status === 'pass') pass += 1
    else if (item.status === 'fail') fail += 1
    else warn += 1
  }
  return { pass, fail, warn }
}

function statusLabel(status) {
  if (status === 'pass') return '通过'
  if (status === 'fail') return '失败'
  return '注意'
}

function buildReport(env, checks, runAt) {
  const lines = []
  const sum = summarize(checks)
  lines.push('点餐小程序 · 环境自检报告')
  lines.push('时间：' + runAt)
  lines.push('数据模式：' + env.modeLabel)
  lines.push('CLOUD_ENV：' + (env.cloudEnv || '（空）'))
  lines.push('基础库支持 wx.cloud：' + (env.hasCloud ? '是' : '否'))
  lines.push('结果：' + sum.pass + ' 通过 / ' + sum.fail + ' 失败 / ' + sum.warn + ' 注意')
  lines.push('')
  for (const item of checks) {
    lines.push('[' + statusLabel(item.status) + '] ' + item.title)
    lines.push('  现象：' + (item.detail || '（无）'))
    lines.push('  处理：' + (item.fix || '（无）'))
  }
  return lines.join('\n')
}

Page({
  data: {
    running: true,
    checks: [],
    passCount: 0,
    failCount: 0,
    warnCount: 0,
    summaryText: '',
    modeLabel: '',
    isLocal: false,
    cloudEnv: '',
    openid: '',
    isMerchant: false,
    canSelfClaim: false,
    reportText: ''
  },

  onLoad() {
    this.run()
  },

  run() {
    const env = api.getEnvInfo()
    const runAt = new Date().toLocaleString('zh-CN')
    const checks = buildClientChecks(env)
    this.setData({
      running: true,
      checks,
      modeLabel: env.modeLabel,
      isLocal: env.isLocal,
      cloudEnv: env.cloudEnv
    })

    api
      .call('health')
      .then((data) => {
        const all = checks.concat(buildServerChecks(data))
        this.finish(env, all, runAt, data)
      })
      .catch((err) => {
        console.error('[diagnose] health 调用失败', err)
        const info = api.describeError(err)
        const all = checks.concat([
          check(
            'api',
            '云函数 api 可达性（未抵达）',
            'fail',
            info.code + '：' + info.message + '（模式：' + info.modeLabel + '）',
            [
              '1) 右键 cloudfunctions/api → 上传并部署：云端安装依赖；',
              '2) 云开发控制台确认环境 ID 是 ordering-d0gyct6z1ff2afebd，并与 app.js 的 CLOUD_ENV 完全一致；',
              '3) 云函数名称必须是 api（对应 cloudfunctions/api 目录），不要改名；',
              '4) 使用 wx.cloud.callFunction({ name, data }) 的 Promise 写法，不要混用旧版 success/fail；',
              '5) 部署后在云开发控制台「云函数 → api → 云端测试」传 {"action":"health"} 验证。'
            ].join('\n')
          )
        ])
        this.finish(env, all, runAt)
      })
  },

  finish(env, checks, runAt, data) {
    const sum = summarize(checks)
    const identity = (data && data.identity) || {}
    const summaryText = sum.pass + ' 项通过 / ' + sum.fail + ' 项失败' + (sum.warn ? ' / ' + sum.warn + ' 项注意' : '')
    this.setData({
      running: false,
      checks,
      passCount: sum.pass,
      failCount: sum.fail,
      warnCount: sum.warn,
      summaryText,
      openid: identity.openid || (data && data.openid) || '',
      isMerchant: identity.isMerchant === true,
      canSelfClaim: identity.canSelfClaim === true,
      reportText: buildReport(env, checks, runAt)
    })
  },

  copyReport() {
    wx.setClipboardData({ data: this.data.reportText || '暂无可复制的自检报告' })
  },

  copyOpenid() {
    if (!this.data.openid) {
      wx.showToast({ title: '未获取到 openid', icon: 'none' })
      return
    }
    wx.setClipboardData({ data: this.data.openid })
  },

  claimSelf() {
    api
      .claimSelfMerchant()
      .then(() => {
        wx.showToast({ title: '已加入商家白名单', icon: 'none' })
        this.run()
      })
      .catch((err) => {
        api.showError(err, '加入商家失败')
        this.run()
      })
  },

  toggleMode() {
    if (this.data.isLocal) {
      wx.showModal({
        title: '切回云端模式',
        content: '将清空本地演示数据与本地商家标记，之后的数据全部读写云端。确认切换？',
        confirmText: '切回云端',
        success: (res) => {
          if (res.confirm) api.switchToCloud()
        }
      })
      return
    }
    wx.showModal({
      title: '切换到本地演示模式',
      content: '本地演示的数据只保存在本机，不会写入云端，其他人看不到。确认切换？',
      confirmText: '用本地演示',
      success: (res) => {
        if (res.confirm) api.switchToLocal()
      }
    })
  },

  goLocalMerchant() {
    api.enterMerchantView()
  },

  goHome() {
    wx.reLaunch({ url: '/pages/menu/menu' })
  }
})
