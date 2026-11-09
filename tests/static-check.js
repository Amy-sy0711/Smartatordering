'use strict'

/**
 * 静态校验（不依赖微信开发者工具 / 云环境）：
 *  1. 所有 .js 走 node --check
 *  2. 所有 .json 走 JSON.parse
 *  3. app.json 页面注册与四件套文件齐全
 *  4. usingComponents 指向的组件存在
 *  5. WXML 顶层标签配对（view / text / block）
 *  6. 集合名与 README、init 云函数一致
 *  7. api 与 pay 的 core/paymode.js、core/errors.js 内容一致
 *  8. 金额路径不含 parseFloat / toFixed 等浮点入口
 *
 * 运行：node tests/static-check.js
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const SKIP_DIRS = ['node_modules', '.git', '.trae', '.vscode', 'miniprogram_npm', 'dist']

let errors = []
const stats = { js: 0, json: 0, wxml: 0, pages: 0, components: 0 }

function walk(dir, onFile) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.indexOf(entry.name) >= 0) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, onFile)
    else onFile(full)
  }
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/')
}

/** 第三方 SDK 只做存在性与语法检查，不套用业务规则（避免 parseFloat/toFixed/phone 误报） */
function isVendored(file) {
  return rel(file).indexOf('/vendor/') >= 0
}

function read(file) {
  return fs.readFileSync(file, 'utf8')
}

function fail(message) {
  errors.push(message)
}

/* ------------------------------- 1. JS 语法 ------------------------------- */
walk(ROOT, (file) => {
  if (!file.endsWith('.js')) return
  stats.js += 1
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (result.status !== 0) {
    fail('JS 语法错误：' + rel(file) + '\n' + (result.stderr || '').trim())
  }
})

/* ------------------------------- 2. JSON ------------------------------- */
walk(ROOT, (file) => {
  if (!file.endsWith('.json')) return
  stats.json += 1
  try {
    JSON.parse(read(file))
  } catch (err) {
    fail('JSON 解析失败：' + rel(file) + ' → ' + err.message)
  }
})

/* --------------------------- 3. 页面注册与文件 --------------------------- */
const MP_ROOT = path.join(ROOT, 'miniprogram')
const appJsonPath = path.join(MP_ROOT, 'app.json')
let appJson = null
try {
  appJson = JSON.parse(read(appJsonPath))
} catch (err) {
  fail('app.json 无法解析：' + err.message)
}

if (appJson) {
  const pages = appJson.pages || []
  if (!pages.length) fail('app.json 未注册任何页面')
  for (const page of pages) {
    stats.pages += 1
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      const file = path.join(MP_ROOT, page + '.' + ext)
      if (!fs.existsSync(file)) fail('页面文件缺失：' + rel(file))
    }
  }
}

/* ------------------------- 4. usingComponents 组件 ------------------------- */
walk(MP_ROOT, (file) => {
  if (!file.endsWith('.json')) return
  let json = null
  try {
    json = JSON.parse(read(file))
  } catch (err) {
    return
  }
  const components = (json && json.usingComponents) || {}
  for (const name of Object.keys(components)) {
    const target = components[name]
    const base = target.startsWith('/')
      ? path.join(MP_ROOT, target.slice(1))
      : path.resolve(path.dirname(file), target)
    stats.components += 1
    for (const ext of ['js', 'json', 'wxml']) {
      if (!fs.existsSync(base + '.' + ext)) {
        fail('组件文件缺失：' + rel(file) + ' → ' + name + ' (' + target + '.' + ext + ')')
      }
    }
  }
})

/* --------------------------- 5. WXML 标签配对 --------------------------- */
walk(MP_ROOT, (file) => {
  if (!file.endsWith('.wxml')) return
  stats.wxml += 1
  const source = read(file).replace(/<!--[\s\S]*?-->/g, '')
  for (const tag of ['view', 'text', 'block']) {
    const open = (source.match(new RegExp('<' + tag + '\\b', 'g')) || []).length
    const close = (source.match(new RegExp('</' + tag + '>', 'g')) || []).length
    if (open !== close) {
      fail('WXML 标签不配对：' + rel(file) + ' <' + tag + '> 开 ' + open + ' / 闭 ' + close)
    }
  }
})

/* ------------------------ 6. 集合名与 README / init ------------------------ */
const collections = require(path.join(ROOT, 'cloudfunctions', 'api', 'core', 'collections'))
const names = collections.COLLECTION_LIST
const readmePath = path.join(ROOT, 'README.md')
const readme = fs.existsSync(readmePath) ? read(readmePath) : ''
if (!readme) {
  fail('README.md 不存在')
} else {
  for (const name of names) {
    if (readme.indexOf(name) < 0) fail('README 未包含集合名：' + name)
  }
}

const initPath = path.join(ROOT, 'cloudfunctions', 'init', 'index.js')
if (fs.existsSync(initPath)) {
  const source = read(initPath)
  const block = /const COLLECTIONS = \[([\s\S]*?)\]/.exec(source)
  if (!block) {
    fail('init/index.js 未找到 COLLECTIONS 数组')
  } else {
    const initNames = (block[1].match(/'([^']+)'/g) || []).map((item) => item.replace(/'/g, ''))
    for (const name of names) {
      if (initNames.indexOf(name) < 0) fail('init 云函数缺少集合：' + name)
    }
    for (const name of initNames) {
      if (names.indexOf(name) < 0) fail('init 云函数多出未登记集合：' + name)
    }
  }
}

const payConfigPath = path.join(ROOT, 'cloudfunctions', 'pay', 'config.js')
if (fs.existsSync(payConfigPath)) {
  const source = read(payConfigPath)
  const block = /const COLLECTIONS = \{([\s\S]*?)\}/.exec(source)
  if (!block) {
    fail('pay/config.js 未找到 COLLECTIONS 对象')
  } else {
    const used = (block[1].match(/'([^']+)'/g) || []).map((item) => item.replace(/'/g, ''))
    for (const name of used) {
      if (names.indexOf(name) < 0) fail('pay/config.js 使用了未登记集合：' + name)
    }
  }
}

/* --------------------- 7. api 与 pay 的 public core 一致 --------------------- */
for (const shared of ['paymode.js', 'errors.js']) {
  const a = path.join(ROOT, 'cloudfunctions', 'api', 'core', shared)
  const b = path.join(ROOT, 'cloudfunctions', 'pay', 'core', shared)
  if (!fs.existsSync(b)) {
    fail('pay 缺少共享模块：' + rel(b))
    continue
  }
  if (read(a).replace(/\r\n/g, '\n') !== read(b).replace(/\r\n/g, '\n')) {
    fail('共享逻辑不一致（需保持内容一致）：api/core/' + shared + ' 与 pay/core/' + shared)
  }
}

/* ------------------------- 8. 金额路径无浮点入口 ------------------------- */
const FLOAT_TOKENS = ['parseFloat', 'Number.parseFloat', 'toFixed']
walk(ROOT, (file) => {
  const isSource = file.endsWith('.js') && !rel(file).startsWith('tests/') && !isVendored(file)
  if (!isSource) return
  const source = read(file)
  for (const token of FLOAT_TOKENS) {
    if (source.indexOf(token) >= 0) fail('金额路径疑似浮点入口：' + rel(file) + ' 含 ' + token)
  }
  const floatCents = /(?:Cents|cents|amount)\s*[*/]\s*(?:\d+\.\d+|0\.\d+)/.exec(source)
  if (floatCents) fail('金额出现浮点运算：' + rel(file) + ' → ' + floatCents[0])
})

/* --------------------------- 9. 相对 require 可解析 --------------------------- */
walk(ROOT, (file) => {
  const isSource = file.endsWith('.js') && !rel(file).startsWith('tests/') && !isVendored(file)
  if (!isSource) return
  const source = read(file)
  const pattern = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g
  let match = pattern.exec(source)
  while (match) {
    const target = path.resolve(path.dirname(file), match[1])
    if (!fs.existsSync(target) && !fs.existsSync(target + '.js') && !fs.existsSync(target + '.json')) {
      fail('require 路径无法解析：' + rel(file) + ' → ' + match[1])
    }
    match = pattern.exec(source)
  }
})

/* --------------------- 10. api / pay 的 WXPAY 配置一致 --------------------- */
function wxpayFields(file) {
  if (!fs.existsSync(file)) return null
  const source = read(file)
  const block = /const WXPAY = \{([\s\S]*?)\}/.exec(source)
  if (!block) return null
  const fields = {}
  for (const key of ['ENABLED', 'SUB_MCH_ID', 'ENV_ID', 'BODY_PREFIX']) {
    const value = new RegExp(key + '\\s*:\\s*([^,\\n]+)').exec(block[1])
    fields[key] = value ? value[1].replace(/\/\/.*$/, '').trim() : '<missing>'
  }
  return fields
}

const apiWxpay = wxpayFields(path.join(ROOT, 'cloudfunctions', 'api', 'config.js'))
const payWxpay = wxpayFields(path.join(ROOT, 'cloudfunctions', 'pay', 'config.js'))
if (!apiWxpay || !payWxpay) {
  fail('未找到 api/config.js 或 pay/config.js 的 WXPAY 配置段')
} else {
  for (const key of Object.keys(apiWxpay)) {
    if (apiWxpay[key] !== payWxpay[key]) {
      fail('WXPAY.' + key + ' 在 api/config.js 与 pay/config.js 中不一致：' + apiWxpay[key] + ' vs ' + payWxpay[key])
    }
  }
}

/* -------------------- 11. 对象字面量缺少分号的 ASI 隐患 -------------------- */
walk(ROOT, (file) => {
  if (!file.endsWith('.js') || rel(file).startsWith('tests/') || isVendored(file)) return
  const lines = read(file).split(/\r?\n/)
  for (let i = 0; i < lines.length - 1; i += 1) {
    const current = lines[i]
    const next = lines[i + 1]
    if (/=\s*(\{\}|\[\])\s*$/.test(current) && /^\s*[\(\[]/.test(next)) {
      fail(
        '疑似 ASI 隐患（对象被当函数调用）：' +
          rel(file) + ':' + (i + 1) + ' 「' + current.trim() + '」 下一行以 ( 或 [ 开头'
      )
    }
  }
})

/* -------- 12. WXML 高风险模板表达式提示（不阻断，人工核对） -------- */
const templateRisks = []
walk(MP_ROOT, (file) => {
  if (!file.endsWith('.wxml')) return
  const source = read(file)
  const pattern = /\{\{[^}]*\?[^}]*\.\s*[A-Za-z_$][^\s}]*\s*\}\}/g
  let match = pattern.exec(source)
  while (match) {
    const line = source.slice(0, match.index).split('\n').length
    templateRisks.push(rel(file) + ':' + line + ' → ' + match[0].replace(/\s+/g, ' '))
    match = pattern.exec(source)
  }
})
if (templateRisks.length) {
  console.log('\n模板高风险表达式（可能输出 undefined，需人工核对）：')
  templateRisks.forEach((item) => console.log('  - ' + item))
}

/* ---------- 13. 商家页面必须接入角色守卫（禁止路径直达） ---------- */
const merchantPagesDir = path.join(MP_ROOT, 'pages', 'merchant')
if (fs.existsSync(merchantPagesDir)) {
  for (const entry of fs.readdirSync(merchantPagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const jsFile = path.join(merchantPagesDir, entry.name, entry.name + '.js')
    if (!fs.existsSync(jsFile)) continue
    const source = read(jsFile)
    if (source.indexOf('merchant-guard') < 0 || source.indexOf('requireMerchant') < 0) {
      fail('商家页缺少角色守卫（非商家可直接路径直达）：' + rel(jsFile))
    }
  }
}

/* ------------- 14. 平台后台与商家后台的边界（不读业务明细） ------------- */
const adminPolicy = require(path.join(ROOT, 'cloudfunctions', 'adminApi', 'core', 'policy'))
const BIZ_COLLECTION_KEYS = ['ORDERS', 'DISHES', 'MENUS', 'CATEGORIES', 'PAYMENT_RECORDS', 'SETTINGS']
const BUSINESS_FIELD_TOKENS = [/\bitems\s*:/, /\bbuyerOpenid\b/, /\bdishIds\b/, /\btotalCents\b/, /\bremark\b/, /\bphone\b/, /\baddress\b/]

const adminApiIndexPath = path.join(ROOT, 'cloudfunctions', 'adminApi', 'index.js')
if (fs.existsSync(adminApiIndexPath)) {
  const source = read(adminApiIndexPath)
  // 平台后台只允许计数/状态/配置：禁止 fetchAll 业务集合、禁止按业务集合取文档
  for (const key of BIZ_COLLECTION_KEYS) {
    if (new RegExp('fetchAll\\([^\\n]*COL\\.' + key + '\\b').test(source)) {
      fail('adminApi 不得整表读取业务集合：COL.' + key)
    }
    if (new RegExp('getDoc\\([^\\n]*COL\\.' + key + '\\b').test(source)) {
      fail('adminApi 不得读取业务集合文档：COL.' + key)
    }
  }
  for (const token of BUSINESS_FIELD_TOKENS) {
    if (token.test(source)) fail('adminApi 源码出现业务明细字段：' + token.source)
  }
  for (const action of adminPolicy.FORBIDDEN_BUSINESS_ACTIONS) {
    if (adminPolicy.PLATFORM_ADMIN_ACTIONS.indexOf(action) >= 0) {
      fail('平台 action 白名单混入业务读取接口：' + action)
    }
  }
}

// 管理员前台：不得出现业务读取 action / 业务字段
const adminConsoleDir = path.join(ROOT, 'admin-console')
if (fs.existsSync(adminConsoleDir)) {
  walk(adminConsoleDir, (file) => {
    if (!file.endsWith('.js') || isVendored(file)) return
    const source = read(file)
    for (const action of adminPolicy.FORBIDDEN_BUSINESS_ACTIONS) {
      if (source.indexOf(action) >= 0) fail('管理台出现业务读取 action：' + action + '（' + rel(file) + '）')
    }
    for (const token of BUSINESS_FIELD_TOKENS) {
      if (token.test(source)) fail('管理台源码出现业务明细字段：' + token.source + '（' + rel(file) + '）')
    }
  })
}

// 商家前台不得混用平台管理员 token / adminApi
const merchantConsoleDir = path.join(ROOT, 'merchant-console')
if (fs.existsSync(merchantConsoleDir)) {
  walk(merchantConsoleDir, (file) => {
    if (!file.endsWith('.js')) return
    const source = read(file)
    if (source.indexOf('adminApi') >= 0) fail('商家后台不得调用 adminApi：' + rel(file))
    if (source.indexOf('ordering_admin_token') >= 0) fail('商家后台不得使用平台管理员 token：' + rel(file))
  })
}

/* ------------- 15. 云函数业务查询必须带 merchantId 过滤 ------------- */
const apiHandlersDir = path.join(ROOT, 'cloudfunctions', 'api', 'handlers')
if (fs.existsSync(apiHandlersDir)) {
  walk(apiHandlersDir, (file) => {
    if (!file.endsWith('.js')) return
    const source = read(file)
    for (const key of BIZ_COLLECTION_KEYS) {
      const marker = 'collection(COL.' + key + ')'
      let from = 0
      while (true) {
        const start = source.indexOf(marker, from)
        if (start < 0) break
        from = start + marker.length
        const window = source.slice(start, start + 700)
        const endMatch = /(\.get\(|\.count\(|\.update\(|\.remove\(|\.add\()/.exec(window)
        const chainEnd = endMatch ? endMatch.index : window.length
        const chain = window.slice(marker.length, chainEnd)
        const after = window.slice(chainEnd)
        // 按租户前缀的文档 ID（.doc(menuId)）、条件含 merchantId、或 add 的数据里带 merchantId 均视为已隔离
        if (chain.indexOf('merchantId') >= 0 || chain.indexOf('.doc(') >= 0) continue
        if (endMatch && endMatch[1] === '.add(' && after.indexOf('merchantId') >= 0) continue
        const line = source.slice(0, start).split('\n').length
        fail('业务查询缺少 merchantId 过滤：' + rel(file) + ':' + line + ' COL.' + key)
      }
    }
  })
}

/* ------------- 16. 两个控制台引用的云函数目录必须存在 ------------- */
const consoleDirs = [adminConsoleDir, merchantConsoleDir]
for (const dir of consoleDirs) {
  if (!fs.existsSync(dir)) {
    fail('控制台目录缺失：' + rel(dir))
    continue
  }
  walk(dir, (file) => {
    if (!file.endsWith('.js')) return
    const source = read(file)
    const pattern = /callFunction\(\s*['"]([A-Za-z0-9_-]+)['"]/g
    let match = pattern.exec(source)
    while (match) {
      const fnDir = path.join(ROOT, 'cloudfunctions', match[1])
      if (!fs.existsSync(fnDir)) fail('控制台调用了不存在的云函数：' + match[1] + '（' + rel(file) + '）')
      match = pattern.exec(source)
    }
  })
}

/* ------------- 17. 环境自检仅平台管理员可进入 ------------- */
const diagnoseJs = path.join(MP_ROOT, 'pages', 'diagnose', 'diagnose.js')
if (fs.existsSync(diagnoseJs)) {
  const source = read(diagnoseJs)
  const adminOnly = source.indexOf("role === 'admin'") >= 0 || source.indexOf("role !== 'admin'") >= 0
  if (!adminOnly || source.indexOf('health') < 0) {
    fail('pages/diagnose 必须仅允许平台管理员进入（缺少管理员角色判断或 health 调用）')
  }
}
walk(MP_ROOT, (file) => {
  if (!file.endsWith('.wxml') && !file.endsWith('.js')) return
  if (read(file).indexOf('goDiagnose') >= 0) fail('小程序仍存在自检入口：' + rel(file))
})
const merchantUiDir = path.join(MP_ROOT, 'pages', 'merchant')
if (fs.existsSync(merchantUiDir)) {
  walk(merchantUiDir, (file) => {
    if (!file.endsWith('.wxml') && !file.endsWith('.js')) return
    if (read(file).indexOf('本地演示') >= 0) fail('商家端仍出现本地演示模式入口：' + rel(file))
  })
}

/* ------------------------------- 9. 管理台静态资源 ------------------------------- */
;['admin-console', 'deploy/admin-console'].forEach((dirName) => {
  const dir = path.join(ROOT, dirName)
  const indexPath = path.join(dir, 'index.html')
  if (!fs.existsSync(indexPath)) {
    fail('缺少管理台入口：' + rel(indexPath))
    return
  }
  const html = read(indexPath)
  const refs = []
  const attrRe = /(?:src|href)\s*=\s*"([^"]+)"/g
  let match = null
  while ((match = attrRe.exec(html)) !== null) refs.push(match[1])
  refs.forEach((ref) => {
    if (/^(https?:|data:|mailto:|#|javascript:)/.test(ref)) return
    const target = path.resolve(dir, ref.split('?')[0].split('#')[0])
    if (!fs.existsSync(target)) fail('管理台引用文件不存在：' + rel(indexPath) + ' → ' + ref)
  })
  if (html.indexOf('static.cloudbase.net') >= 0) fail('管理台仍在引用 CDN SDK：' + rel(indexPath))
  if (html.indexOf('vendor/cloudbase.full.js') < 0) fail('管理台未引用本地 SDK：' + rel(indexPath))
  ;['app.js', 'login-state.js', 'style.css', 'vendor/cloudbase.full.js'].forEach((file) => {
    if (!fs.existsSync(path.join(dir, file))) fail('管理台缺少文件：' + rel(path.join(dir, file)))
  })
})

/* ------------------------------- 10. 诊断信息 / 备用链路 / 平台管理页 ------------------------------- */
;['admin-console', 'deploy/admin-console'].forEach((dirName) => {
  const dir = path.join(ROOT, dirName)
  const indexPath = path.join(dir, 'index.html')
  if (!fs.existsSync(indexPath)) return
  const html = read(indexPath)
  if (!fs.existsSync(path.join(dir, 'diagnostics.js'))) fail('管理台缺少错误诊断模块：' + rel(path.join(dir, 'diagnostics.js')))
  if (html.indexOf('diagnostics.js') < 0) fail('管理台未引用 diagnostics.js：' + rel(indexPath))
  if (html.indexOf('btn-copy-diagnostics') < 0) fail('管理台缺少「复制诊断信息」按钮：' + rel(indexPath))
  if (html.indexOf('conn-mode') < 0) fail('管理台缺少连接方式切换：' + rel(indexPath))
  const appIdx = html.indexOf('app.js')
  const diagIdx = html.indexOf('diagnostics.js')
  if (diagIdx >= 0 && appIdx >= 0 && diagIdx > appIdx) fail('diagnostics.js 必须在 app.js 之前加载：' + rel(indexPath))
})

const adminApiIndex = path.join(ROOT, 'cloudfunctions', 'adminApi', 'index.js')
if (fs.existsSync(adminApiIndex)) {
  const src = read(adminApiIndex)
  if (src.indexOf("require('./core/http-adapter')") < 0) fail('adminApi 未接入 HTTP 适配模块')
  if (src.indexOf('x-admin-token') < 0 && src.indexOf('extractToken') < 0) fail('adminApi HTTP 入口未解析 x-admin-token / query token')
  if (src.indexOf('OPTIONS') < 0) fail('adminApi HTTP 入口缺少 OPTIONS 预检处理')
  if (src.indexOf('getWXContext') < 0) fail('adminApi 缺少小程序 openid 鉴权（平台管理页依赖）')
}

const gatewayCore = path.join(ROOT, 'tools', 'admin-gateway', 'core.js')
const gatewayServer = path.join(ROOT, 'tools', 'admin-gateway', 'server.js')
if (!fs.existsSync(gatewayCore) || !fs.existsSync(gatewayServer)) fail('缺少本地代理 tools/admin-gateway/{core,server}.js')
if (fs.existsSync(gatewayServer)) {
  const src = read(gatewayServer)
  if (src.indexOf('127.0.0.1') < 0) fail('本地网关未限制在本机 127.0.0.1 监听')
  if (src.indexOf('8787') < 0) fail('本地网关未使用默认端口 8787')
  if (!/process\.env\.WX_APPID/.test(src)) fail('本地网关未从环境变量读取 WX_APPID')
  if (!/process\.env\.WX_APPSECRET/.test(src)) fail('本地网关未从环境变量读取 WX_APPSECRET')
  if (src.indexOf('cgi-bin/token') < 0) fail('本地网关未通过 cgi-bin/token 获取 access_token')
  if (src.indexOf('invokecloudfunction') < 0) fail('本地网关未通过 invokecloudfunction 调用云函数')
  if (src.indexOf('GATEWAY_TOKEN') < 0) fail('本地网关缺少本机口令校验')
  if (/appsecret\s*[:=]\s*['"][A-Za-z0-9]{10,}/i.test(src)) fail('本地网关疑似硬编码 AppSecret')
  if (src.indexOf('isAllowedAction') < 0) fail('本地网关缺少路由白名单')
  if (src.indexOf('injectGatewayConfig') < 0) fail('本地网关未向静态页注入配置')
}
/* 注入模式：页面配置来自网关，不再要求手填 HTTP 地址 */
const consoleApp = path.join(ROOT, 'admin-console', 'app.js')
const consoleHtml = path.join(ROOT, 'admin-console', 'index.html')
if (fs.existsSync(consoleApp)) {
  const src = read(consoleApp)
  if (src.indexOf('__GATEWAY__') < 0) fail('管理台未读取网关注入的 __GATEWAY__ 配置')
  if (src.indexOf("/admin") < 0) fail('管理台未使用 /api/admin 请求体')
  if (src.indexOf('x-gateway-token') < 0) fail('管理台请求未带 x-gateway-token')
}
if (fs.existsSync(consoleHtml) && read(consoleHtml).indexOf('<!--GATEWAY_CONFIG-->') < 0) {
  fail('管理台 index.html 缺少网关配置占位符 <!--GATEWAY_CONFIG-->')
}
if (fs.existsSync(gatewayCore)) {
  const src = read(gatewayCore)
  if (src.indexOf('isAllowedAction') < 0) fail('本地网关 core 缺少 action 白名单')
  if (src.indexOf('FORBIDDEN_ACTIONS') < 0) fail('本地网关 core 缺少业务明细禁用名单')
}

/* 前端/管理台不得出现 AppSecret 或云 API 密钥；浏览器管理台不得出现订单/菜品字段 */
;['admin-console/app.js', 'admin-console/index.html', 'admin-console/diagnostics.js',
  'deploy/admin-console/app.js', 'deploy/admin-console/index.html', 'deploy/admin-console/diagnostics.js',
  'miniprogram/pages/platform-admin', 'miniprogram/utils/platform-guard.js'].forEach((item) => {
  const target = path.join(ROOT, item)
  if (!fs.existsSync(target)) return
  const files = fs.statSync(target).isDirectory()
    ? fs.readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(target, entry.name)
      return entry.isDirectory() ? [] : [full]
    })
    : [target]
  files.forEach((file) => {
    const src = read(file)
    if (/TENCENT_SECRET_ID|TENCENT_SECRET_KEY|SecretId|SecretKey|WX_APPSECRET|AppSecret/.test(src)) {
      fail('前端出现密钥字样/密钥：' + rel(file))
    }
    if (/order\.list|merchant\.orders|merchant\.dishes|dish\.list|exportOrders/.test(src)) fail('前端出现业务明细接口：' + rel(file))
  })
})

const platformAppJsonText = read(path.join(MP_ROOT, 'app.json'))
;['pages/platform-admin/index/index', 'pages/platform-admin/detail/detail', 'pages/platform-admin/audit/audit'].forEach((page) => {
  if (platformAppJsonText.indexOf(page) < 0) fail('app.json 未注册平台管理页：' + page)
  ;['js', 'json', 'wxml', 'wxss'].forEach((ext) => {
    const file = path.join(MP_ROOT, page + '.' + ext)
    if (!fs.existsSync(file)) fail('平台管理页缺少文件：' + rel(file))
  })
  if (page.indexOf('/detail/') >= 0 || page.indexOf('/audit/') >= 0 || page.indexOf('/index/') >= 0) {
    const js = read(path.join(MP_ROOT, page + '.js'))
    if (js.indexOf("require('../../../utils/platform-guard')") < 0) fail('平台管理页缺少路由守卫：' + page)
    if (js.indexOf('if (decision.needBind)') < 0 && js.indexOf('decision.needBind') < 0) fail('平台管理页未处理未绑定状态：' + page)
  }
})
if (read(path.join(MP_ROOT, 'pages', 'menu', 'menu.wxml')).indexOf('goPlatformAdmin') < 0) fail('菜单页缺少平台管理入口（仅管理员可见）')

/* 菜单左栏联动与菜品图预览 */
const menuWxml = read(path.join(MP_ROOT, 'pages', 'menu', 'menu.wxml'))
const menuJs = read(path.join(MP_ROOT, 'pages', 'menu', 'menu.js'))
if (menuWxml.indexOf('cat-rail') < 0) fail('菜单页缺少左侧分类栏')
if (menuWxml.indexOf('bindscroll="onDishScroll"') < 0) fail('菜单页缺少列表滚动监听')
if (menuWxml.indexOf('scroll-into-view') < 0) fail('菜单页缺少点击分类后的滚动定位')
if (menuWxml.indexOf('onDishImageTap') < 0) fail('菜单页菜品图缺少预览点击')
if (menuJs.indexOf('categoryScroll.computeOffsets') < 0) fail('菜单页未测量分类标题偏移')
if (menuJs.indexOf('imagePreview.previewDish') < 0) fail('菜单页未使用图片预览工具')
if (!fs.existsSync(path.join(MP_ROOT, 'utils', 'category-scroll.js'))) fail('缺少工具：utils/category-scroll.js')
if (!fs.existsSync(path.join(MP_ROOT, 'utils', 'image-preview.js'))) fail('缺少工具：utils/image-preview.js')
if (read(path.join(MP_ROOT, 'pages', 'cart', 'cart.wxml')).indexOf('onDishImageTap') < 0) fail('购物车菜品图缺少预览点击')
if (read(path.join(MP_ROOT, 'pages', 'order-detail', 'order-detail.js')).indexOf('imagePreview.previewDish') < 0) fail('订单详情未接入图片预览')

/* 菜单页购物车清单弹层 */
if (menuWxml.indexOf('bindtap="goOrders"') >= 0 && menuWxml.indexOf('cartbar-left') >= 0) {
  const cartbarBlock = menuWxml.slice(menuWxml.indexOf('class="cartbar"'))
  const leftBlock = cartbarBlock.slice(0, cartbarBlock.indexOf('</view>'))
  if (leftBlock.indexOf('goOrders') >= 0) fail('购物车条左侧仍跳订单页（应打开购物车弹层）')
}
if (menuWxml.indexOf('openCartSheet') < 0) fail('购物车条左侧未打开购物车清单弹层')
if (menuWxml.indexOf('cart-sheet-mask') < 0) fail('缺少购物车弹层遮罩')
if (menuWxml.indexOf('onCartStep') < 0 || menuWxml.indexOf('onCartRemove') < 0) fail('购物车弹层缺少增减/删除操作')
if (menuJs.indexOf('cartSheet.buildRows') < 0) fail('菜单页未使用 cart-sheet 组装弹层行')
if (!fs.existsSync(path.join(MP_ROOT, 'utils', 'cart-sheet.js'))) fail('缺少工具：utils/cart-sheet.js')

/* 商家确认收款 + 取餐码 */
const stateCore = read(path.join(ROOT, 'cloudfunctions', 'api', 'core', 'state.js'))
if (stateCore.indexOf("confirm: { to: 'paid', from: ['pending_pay', 'pending_confirm'] }") < 0) {
  fail('状态机：确认收款应支持 pending_pay 与 pending_confirm')
}
const merchantHandler = read(path.join(ROOT, 'cloudfunctions', 'api', 'handlers', 'merchant.js'))
if (merchantHandler.indexOf('pickupCode.nextPickupCode') < 0) fail('商家出餐未分配取餐码')
if (merchantHandler.indexOf("status: state.STATUS.PENDING_CONFIRM, merchantId") >= 0) {
  fail('确认收款仍写死只匹配 pending_confirm')
}
if (merchantHandler.indexOf("payment_records") < 0 && merchantHandler.indexOf('COL.PAYMENT_RECORDS') < 0) {
  fail('确认收款未写入收款记录')
}
const pickupCore = read(path.join(ROOT, 'cloudfunctions', 'api', 'core', 'pickup-code.js'))
if (pickupCore.indexOf('_.inc(1)') < 0) fail('取餐码未使用原子自增 _.inc(1)')
if (pickupCore.indexOf('runTransaction') < 0) fail('取餐码自增缺少事务保护')
const orderHandler = read(path.join(ROOT, 'cloudfunctions', 'api', 'handlers', 'order.js'))
if (orderHandler.indexOf('CUSTOMER_STATUS_TEXT') < 0) fail('订单视图缺少顾客端状态文案')
if (orderHandler.indexOf('pickupCode') < 0) fail('订单视图未返回取餐码')
if (read(path.join(MP_ROOT, 'pages', 'orders', 'orders.wxml')).indexOf('pickup-code') < 0) {
  fail('我的订单未展示取餐码')
}
if (read(path.join(MP_ROOT, 'pages', 'order-detail', 'order-detail.wxml')).indexOf('order.pickupCode') < 0) {
  fail('订单详情未展示取餐码')
}
const boardWxml = read(path.join(MP_ROOT, 'pages', 'merchant', 'board', 'board.wxml'))
if (boardWxml.indexOf('确认收款') < 0) fail('商家订单看板缺少「确认收款」按钮')
const localBackendText = read(path.join(MP_ROOT, 'utils', 'local-backend.js'))
if (localBackendText.indexOf('pickupCounters') < 0) fail('本地演示后端未实现取餐码计数')

/* 本次需求明确不做订阅消息，相关代码不得出现 */
const forbiddenSubscribe = ['requestSubscribeMessage', 'subscribeMessage.send', 'SUBSCRIBE_TEMPLATE']
walk(ROOT, (file) => {
  if (!/\.(js|json|wxml)$/.test(file)) return
  if (rel(file).indexOf('tests/') === 0) return
  const text = read(file)
  forbiddenSubscribe.forEach((token) => {
    if (text.indexOf(token) >= 0) fail('不应出现订阅消息实现：' + token + ' in ' + rel(file))
  })
})

/* ------------------------------- 结果 ------------------------------- */
console.log('静态校验统计：')
console.log('  JS 文件        ' + stats.js)
console.log('  JSON 文件      ' + stats.json)
console.log('  WXML 文件      ' + stats.wxml)
console.log('  注册页面       ' + stats.pages)
console.log('  组件引用       ' + stats.components)
console.log('  集合名单       ' + names.join(', '))

if (errors.length) {
  console.log('\n发现 ' + errors.length + ' 个问题：')
  errors.forEach((message, index) => console.log('  ' + (index + 1) + '. ' + message))
  process.exit(1)
}
console.log('\n静态校验全部通过')
