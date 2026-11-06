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
  const isSource = file.endsWith('.js') && !rel(file).startsWith('tests/')
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
  const isSource = file.endsWith('.js') && !rel(file).startsWith('tests/')
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
  if (!file.endsWith('.js') || rel(file).startsWith('tests/')) return
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
