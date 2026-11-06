'use strict'

/**
 * 管理员登录的纯逻辑与错误码映射。
 * 不依赖 wx-server-sdk，可直接被单元测试引用。
 */

/** 错误码 → 默认文案 + 可执行的修法 */
const ERROR_MAP = {
  ENV_MISSING: {
    message: '云函数未配置初始口令 ADMIN_BOOTSTRAP_PASSWORD',
    hint: '云开发控制台 → 云函数 → adminAuth → 环境变量，新增 ADMIN_BOOTSTRAP_PASSWORD（至少 8 位）；保存后重新部署云函数，再回管理台重试。'
  },
  ADMINS_COLLECTION_MISSING: {
    message: '数据库集合 admins 不存在',
    hint: '云开发控制台 → 数据库 → 新建集合 admins；或配置 ADMIN_BOOTSTRAP_PASSWORD 后重新部署 adminAuth，由云函数在首次初始化时自动创建。'
  },
  ALREADY_INITIALIZED: {
    message: '管理员已存在，不能再走首次初始化',
    hint: '请用已有管理员账号登录；若确实要重置，请先在云开发控制台 → 数据库 → admins 集合里删除全部记录，再重新部署后用初始口令创建。'
  },
  INVALID_CREDENTIALS: {
    message: '用户名或密码不正确',
    hint: '首次初始化时密码必须与环境变量 ADMIN_BOOTSTRAP_PASSWORD 完全一致；已有管理员请确认用户名，或让另一位管理员在管理台重置。'
  },
  TOKEN_SECRET_MISSING: {
    message: '云函数未配置登录签名密钥 ADMIN_TOKEN_SECRET（至少 16 位）',
    hint: '云开发控制台 → 云函数 → adminAuth / adminApi → 环境变量，各新增 ADMIN_TOKEN_SECRET（≥16 位随机字符串，两处必须一致）；保存后重新部署两个云函数。'
  },
  ANONYMOUS_REQUIRED: {
    message: '未检测到匿名登录态',
    hint: '云开发控制台 → 设置 → 登录方式 → 开启「匿名登录」；同时确认该页面域名已加入「Web 安全域名」，然后刷新页面。'
  },
  USERNAME_INVALID: {
    message: '用户名需为 1-32 个字符',
    hint: '请填写普通用户名（建议 admin），不要带空格或特殊符号。'
  },
  PASSWORD_REQUIRED: {
    message: '请输入密码',
    hint: '首次登录的密码就是 ADMIN_BOOTSTRAP_PASSWORD 的值。'
  },
  UNKNOWN_ACTION: {
    message: '未知的管理员认证接口',
    hint: '请确认云函数 adminAuth 已部署为最新版本（action 应为 login / verify / precheck / diagnose）。'
  },
  INTERNAL_ERROR: {
    message: '管理员认证执行失败',
    hint: '查看云开发控制台 → 云函数 → adminAuth → 日志，按日志里的 errCode 定位；常见为集合不存在或数据库权限不足。'
  }
}

function fail(code, message, hint) {
  const fallback = ERROR_MAP[code] || ERROR_MAP.INTERNAL_ERROR
  const out = {
    ok: false,
    code: code,
    message: String(message || fallback.message),
    hint: String(hint || fallback.hint)
  }
  return out
}

function isCollectionMissing(err) {
  if (!err) return false
  const code = String(err.errCode || err.code || '')
  const msg = String(err.errMsg || err.message || '')
  if (code === '-502005' || code === 'DATABASE_COLLECTION_NOT_EXIST') return true
  return /collection.*not\s*exist|collection.*not\s*found|集合.*不存在|集合.*未创建/i.test(msg)
}

/**
 * 纯决策：给定集合状态、账号状态、环境变量状态，返回下一步动作或结构化错误。
 * 入参：
 *  - collectionErrorText: 非「集合不存在」的查询错误（如权限不足），有值即直接失败
 *  - tokenSecretOk: ADMIN_TOKEN_SECRET 是否已配置（≥16 位）
 *  - collectionExists: admins 集合是否存在
 *  - adminTotal: admins 记录数
 *  - adminFound: 是否按用户名查到管理员
 *  - passwordMatches: 已有管理员的密码校验结果
 *  - hasBootstrap: 是否配置了 ADMIN_BOOTSTRAP_PASSWORD
 *  - bootstrapMatches: 用户提交的密码是否等于初始口令
 * 返回：{ ok:true, mode:'login'|'bootstrap', createCollection } 或 { ok:false, code, message, hint }
 */
function planLogin(input) {
  const state = input || {}
  if (state.collectionErrorText) {
    return fail('INTERNAL_ERROR', '查询 admins 集合失败：' + state.collectionErrorText)
  }
  // 先校验签名密钥：缺失时即使密码正确也签不出 token，绝不能先写库（否则会留下一个永远登不进去的管理员）
  if (!state.tokenSecretOk) return fail('TOKEN_SECRET_MISSING')

  if (!state.collectionExists) {
    if (!state.hasBootstrap) return fail('ADMINS_COLLECTION_MISSING')
    if (!state.bootstrapMatches) return fail('INVALID_CREDENTIALS', '初始口令不正确')
    return { ok: true, mode: 'bootstrap', createCollection: true }
  }

  if (state.adminFound) {
    if (!state.passwordMatches) return fail('INVALID_CREDENTIALS')
    return { ok: true, mode: 'login', createCollection: false }
  }

  const total = Number(state.adminTotal) || 0
  if (total > 0) return fail('ALREADY_INITIALIZED', '管理员已存在（共 ' + total + ' 个）')

  if (!state.hasBootstrap) return fail('ENV_MISSING')
  if (!state.bootstrapMatches) return fail('INVALID_CREDENTIALS', '初始口令不正确')
  return { ok: true, mode: 'bootstrap', createCollection: false }
}

module.exports = { ERROR_MAP, fail, isCollectionMissing, planLogin }
