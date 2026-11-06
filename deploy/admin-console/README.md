# 平台运营后台（浏览器 + 小程序）部署与使用

本目录是浏览器管理台的静态文件；小程序内平台管理页在 `miniprogram/pages/platform-admin/`；本机网关在 `tools/admin-gateway/`。

```
deploy/admin-console/
├─ index.html
├─ app.js
├─ diagnostics.js          # 错误归一化 + 诊断信息组装
├─ style.css
├─ login-state.js          # 登录按钮状态机（loading 反馈）
└─ vendor/
   └─ cloudbase.full.js    # CloudBase Web SDK 2.17.5（本地固化，离线可用）
```

单文件版在上一级：`deploy/admin-console-standalone.html`（CSS / JS / SDK 全部内联）。

---

## 0. 三种访问方式怎么选（结论）

| 方式 | 入口 | 前提 | 当前环境 | 推荐 |
| --- | --- | --- | --- | --- |
| **B2 本机网关** | 浏览器打开 `http://127.0.0.1:8787/` | 本机装 Node，配置 `WX_APPID` + `WX_APPSECRET` | **可用（仅本机）** | ★ 浏览器主路径 |
| **C 小程序内平台管理** | 小程序「菜单」页 → 底部「平台管理」 | 管理员账号密码绑定当前微信 openid | **可用** | ★ 手机/外出时用 |
| B1 HTTP 访问服务 | 浏览器管理台「HTTP 访问服务」模式 | 云开发控制台提供 HTTP 访问服务 | **不可用**（控制台无此能力） | 不用 |
| A 浏览器匿名登录直连 | 管理台「小程序云调用」模式 | 服务端实现浏览器匿名登录 + Web 安全域名 | **不可用** | 已停止投入 |

**A 为什么不可用（实测响应体）**

```json
{"code":"UNIMPLEMENTED","error":"unimplemented","error_code":12,
 "error_description":"Method Not Allowed",
 "requestId":"91bddf89-a962-4235-85b7-12b7aa90df92"}
```

服务端未实现浏览器端匿名登录接口（`Method Not Allowed`），**不是 Web 安全域名或匿名登录开关的问题**，改配置、换本地 SDK 都无效。

**B1 为什么不可用**：该环境云开发控制台的「扩展能力」只有 环境共享 / 静态网站托管 / SQL 数据库 / 云托管 / 内容安全，没有 HTTP 访问服务。`adminApi` 的 HTTP 适配代码与 CORS 处理已保留（未来环境若开通即可用），但当前不作为路径。

---

## 1. 浏览器版三步（B2 本机网关）

### 第 1 步：配置 AppID 与 AppSecret（只放环境变量）

获取路径：**微信公众平台 mp.weixin.qq.com → 登录小程序 → 开发管理 → 开发设置 → AppSecret（重置后只会显示一次）**。AppID 在同页「开发者 ID」。

PowerShell（仅当前窗口生效）：

```powershell
$env:WX_APPID="wx1234567890abcdef"
$env:WX_APPSECRET="你的 AppSecret"
# 可选：默认环境 ID 已是 ordering-d0gyct6z1ff2afebd
$env:TCB_ENV_ID="ordering-d0gyct6z1ff2afebd"
```

> AppSecret 只存在于网关进程内存/环境变量，**不会写入任何文件、不会出现在前端、不进仓库**。`.gitignore` 已排除 `tools/admin-gateway/.env.local`。

### 第 2 步：启动网关

```bat
cd tools\admin-gateway
start.bat
```

或：

```powershell
cd tools\admin-gateway
npm start
```

未配 `WX_APPID` / `WX_APPSECRET` 时启动会直接报错并打印上面的获取路径。

启动成功后终端会打印：

```
[admin-gateway] 已启动：http://127.0.0.1:8787
[admin-gateway] 管理台地址：http://127.0.0.1:8787/    （API: /api）
[admin-gateway] 本机口令（已写入 .env.local 的 GATEWAY_TOKEN）：<随机串>
[admin-gateway] 环境 ID：ordering-d0gyct6z1ff2afebd
[admin-gateway] 仅监听 127.0.0.1，请勿把 8787 端口映射到公网
```

### 第 3 步：浏览器打开

```
http://127.0.0.1:8787/
```

静态页面由网关同源托管，**没有 CORS、不需要匿名登录、不需要域名白名单**。网关在返回 `index.html` 时会把 `<!--GATEWAY_CONFIG-->` 替换成：

```js
window.__GATEWAY__ = { mode: 'gateway', base: '/api', token: '<GATEWAY_TOKEN>' }
```

页面检测到它后会：强制 `gateway` 模式、隐藏「连接方式 / 网关地址 / 本机口令」与匿名登录相关提示、登录按钮直接可用；请求固定为 `POST /api/login`（登录）与 `POST /api/admin`（`{ token(管理员 token), action, payload }`，均带 `x-gateway-token`）。顶部显示「本地网关 · 已连接」；网关停掉后显示「未启动（请运行 tools\admin-gateway\start.bat）」，错误区保留 `code · message · hint` 和复制按钮。

- 用管理员账号 + 密码登录（初始口令见 `ADMIN_BOOTSTRAP_PASSWORD`）；token 存 `sessionStorage`，退出即清除。
- 若你手动把 `deploy/admin-console` 放到其它静态服务器（无注入），页面会回退为手填网关地址/口令的模式；此时建议直接用 `http://127.0.0.1:8787/`。

---

## 2. 本机网关是怎么工作的

```
浏览器 (http://127.0.0.1:8787/)
   │  POST /api  { token, action, payload }   + x-gateway-token
   ▼
tools/admin-gateway/server.js (127.0.0.1:8787，零依赖 Node)
   │  1) 校验 GATEWAY_TOKEN
   │  2) access_token = GET api.weixin.qq.com/cgi-bin/token?grant_type=client_credential
   │     （缓存 7000s，提前 200s 刷新，并发共享同一个 inflight）
   │  3) POST api.weixin.qq.com/tcb/invokecloudfunction?access_token=..&env=..&name=adminApi
   ▼
云函数 adminApi / adminAuth（复用现有 token 鉴权 + 审计日志）
```

- `GET /api/health` → `{ok, service, envId, gwTokenRequired, tokenCached, fetchedAt}`，页面用它判断「已连接 / 未启动」。
- `POST /api/login` → 转发 `adminAuth` 的 `login`，body 直接是 `{username, password}`。
- `POST /api/admin` → body `{token(管理员 token), action, payload}`，按 action 分流到 `adminApi`（`precheck/verify` 走 `adminAuth`）。
- 未配 `GATEWAY_TOKEN` 时网关首次启动会随机生成 24 字节 hex，追加写入 `tools/admin-gateway/.env.local` 并打印。

### 路由白名单（只暴露平台管理接口）

允许：`merchant.list/create/update/setStatus/setFlags/resetPassword`、`staff.list/bind/unbind`、`health`、`audit.list`、`error.summary`、`repair.*`、`admin.changePassword`。

拒绝：订单、菜品、菜单明细、顾客、统计明细、支付记录等任何业务明细（返回 `FORBIDDEN_ACTION`）。

---

## 3. 方式 C：小程序内「平台管理」（手机端主路径）

### 进入路径（小程序里点哪里）

1. 打开小程序 → 进入「菜单」页。
2. 页面底部「平台管理」（**仅平台管理员 openid 可见**）。
3. 首次进入要求绑定：填管理员账号（默认 `admin`）和密码
   - 还没有管理员：密码填云函数 `adminAuth` 环境变量 `ADMIN_BOOTSTRAP_PASSWORD` 的值，会创建管理员并把当前 openid 绑到 `admins.openid`。
   - 已有管理员：填该管理员账号密码，校验通过后把当前 openid 绑到该记录。
   - 失败会显示 `ADMIN_OPENID_NOT_BOUND` / `INVALID_CREDENTIALS` 及修法，并可「复制当前 openid」。
4. 绑定成功后进入商家列表：搜索、启停、新建、编辑套餐/到期/开关、员工绑定/解绑、商家详情、健康检查、修复动作、审计日志。

### 页面

- `pages/platform-admin/index/index`：商家列表 / 新建 / 编辑 / 启停 / 员工绑定
- `pages/platform-admin/detail/detail`：单商家健康、集合计数、开关、修复动作、员工
- `pages/platform-admin/audit/audit`：审计日志（只读）

### 鉴权

小程序内调 `adminApi` 不带 token：云函数用 `wx.cloud.callFunction` 自带的 `OPENID` 匹配 `admins.openid`（`authorize` 的 `via: 'openid'`）。**不存 token、不依赖匿名登录与 Web 安全域名。**路由守卫在 `miniprogram/utils/platform-guard.js`，校验失败 → toast + `reLaunch` 回菜单页，不会继续调用 adminApi。

---

## 4. 管理台连接方式与诊断

页面顶部「连接方式」默认 **本地网关**：

- `local`：本地网关（默认，地址 `http://127.0.0.1:8787/api`）
- `cloud`：小程序云调用（A，当前环境不可用，仅保留对照；选择后首屏直接提示 UNIMPLEMENTED）

配置存 `localStorage`（`ordering_admin_conn_mode` / `ordering_admin_http_endpoint`）。

登录/调用失败时页面会：

1. 原样显示 `code · message`（`diagnostics.js` 的 `describeError` / `formatErrorText`），**不再出现「未知错误」**；
2. 附上 HTTP 状态码 / 请求 URL / requestId / 原始错误对象（`safeSerialize` 处理循环引用）；
3. 提供「复制错误信息」和「复制诊断信息」按钮。诊断信息包含：时间、`location.origin`、环境 ID、SDK 版本与是否加载、连接方式与地址、本机口令是否已填、最后一次调用完整错误对象、页面全局错误列表。

---

## 5. 首次管理员与环境变量

`adminAuth` 与 `adminApi` 都需要配置并**重新部署**（右键函数 → 上传并部署：云端安装依赖）：

| 变量 | 作用 |
| --- | --- |
| `ADMIN_TOKEN_SECRET` | 管理员 token 签名密钥（≥16 位，两个函数一致） |
| `ADMIN_BOOTSTRAP_PASSWORD` | 首次创建管理员 / 小程序首次绑定 openid 的初始口令，创建成功后建议删除 |
| `ADMIN_HTTP_ALLOWED_ORIGINS` | 可选，B1 的 CORS 白名单（当前环境用不到） |

首次初始化后到「修复工具 → 修改管理员密码」设置正式密码，并删除 `ADMIN_BOOTSTRAP_PASSWORD`。

---

## 6. 排障对照表

| 现象 / code | 含义 | 修法 |
| --- | --- | --- |
| 页面「本地网关 · 未启动」 | 网关没跑或端口不对 | 在电脑执行 `cd tools\admin-gateway` → `start.bat`（或 `npm start`），保持终端窗口开启 |
| `GATEWAY_NOT_RUNNING` / `Failed to fetch` | 同上（浏览器直接访问 `/api` 失败） | 同上；确认地址是 `http://127.0.0.1:8787/api`，不要写成云开发域名 |
| 启动报「未配置 WX_APPID / WX_APPSECRET」 | 环境变量缺失 | 按第 1 步设置；注意 `$env:` 只在当前窗口有效，新开窗口要重设 |
| `WX_INVALID_CREDENTIAL` / `40013` | AppID 不合法 | 核对 `WX_APPID` 是否为该小程序 AppID（不是公众号/开放平台 AppID） |
| `WX_SECRET_INVALID` / `40125` | AppSecret 错误 | 到 开发管理 → 开发设置 重置 AppSecret 后重新设置环境变量并重启网关 |
| `40001` / `42001`（access_token 失效或过期） | token 被顶掉或过期 | 网关已内置「失效即 `reset()` 后自动重试一次」；仍失败就重启网关 |
| `45009` | 接口调用频率超限（每日上限） | 等次日或减少刷新频率；不要频繁重启网关反复取 token |
| `-1` / 系统繁忙 | 微信侧临时错误 | 网关按可重试处理（自动刷新 token 重试一次）；仍失败稍后再试 |
| `GATEWAY_TOKEN_MISSING` / `GATEWAY_TOKEN_INVALID` | 本机口令缺失或不匹配 | 用终端打印的口令；或删掉 `.env.local` 里 `GATEWAY_TOKEN` 后重启自动重新生成 |
| `UNIMPLEMENTED` / `error_code: 12` / `Method Not Allowed` | 当前环境未实现浏览器匿名登录（A 不可用） | 改用本地网关（B2）或小程序「平台管理」（C），不要再调白名单 |
| `cloudbase is not defined` / 横幅「SDK 加载失败」 | 本地 SDK 路径不对（仅 A 模式用） | A 已不用；若坚持对照，保持 `index.html` 与 `vendor/` 同级，F12 看是否 404 |
| Console `400 (Bad Request)`，URL 含环境 ID | 匿名登录被拒（仅 A 模式） | 换 B2/C |
| `ANONYMOUS_AUTH_DISABLED` | 匿名登录开关未开（仅 A 模式） | 换 B2/C |
| `-502005 collection not exists` | `admins` 等集合不存在 | 新版 `adminAuth` 首次初始化自动创建；否则控制台手动建集合 |
| `TOKEN_SECRET_MISSING` | `ADMIN_TOKEN_SECRET` 未配置或不足 16 位 | 两个云函数配同一个值，重新部署 |
| `INVALID_CREDENTIALS` | 账号密码/初始口令不对 | 核对环境变量（无空格/引号）；已有账号用原密码 |
| `ADMIN_OPENID_NOT_BOUND` | 当前微信未绑定平台管理员 | 在小程序「平台管理」用管理员账号密码绑定；或 `admins.openid` 填入当前 openid |
| `WX_CONTEXT_REQUIRED` | 无 openid（非小程序环境） | 用微信小程序打开；确认 `wx.cloud.init` 环境 ID 正确 |
| `FORBIDDEN_ACTION` | 网关拒绝了业务明细接口 | 属预期行为：平台管理不读取订单/菜品/顾客明细 |
| `CALL_FUNCTION_FAILED` | 云函数未部署 / 环境 ID 不对 | 用「复制诊断信息」里的 `code/message/requestId` 排查；确认 `adminApi` 已部署 |
| `file://` 横幅 | 直接双击打开 | 用 `http://127.0.0.1:8787/` 打开 |

---

## 7. 上传方式（可选）

浏览器版推荐直接用本机网关托管（第 1~3 步），无需上传。若要公网访问：

- 云托管 / 静态网站托管：把本目录文件上传（`index.html` 与 `vendor/` 同级），再把连接方式指到一个可公网访问的网关（需自行加固，不要让 AppSecret 出现在前端）。
- GitHub Pages 等静态站：同上；注意匿名登录已不可用，纯静态站只能配合外部网关使用。

---

## 8. 安全边界

- AppSecret 只在网关进程内存/环境变量，不写文件、不进前端、不进仓库；`.env.local` 已在 `.gitignore` 中
- 网关只绑定 `127.0.0.1`，仅限本人电脑使用；**不要改成 `0.0.0.0`，不要把 8787 端口映射到公网**；公网需求后续上云托管
- 网关只转发 action 白名单，不暴露订单/菜品/顾客明细
- 小程序内只用 openid 白名单鉴权，不把管理员 token 写本地
- 所有写操作（启停、改套餐、绑员工、修复、改密）都会写入 `audit_logs`，审计页可查
