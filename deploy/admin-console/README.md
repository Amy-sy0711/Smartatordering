# 平台运营后台部署包（deploy/admin-console）

本目录只包含部署所需的三个文件：

- `index.html`
- `app.js`
- `style.css`

同一份单文件版本在上一级：`deploy/admin-console-standalone.html`（CSS/JS 已内联，可直接丢到任意静态托管）。

页面已固定：

- 环境 ID：`ordering-d0gyct6z1ff2afebd`
- CloudBase JS SDK：CDN `https://static.cloudbase.net/cloudbase-js-sdk/2.17.5/cloudbase.full.js`（版本固定 2.17.5）
- 匿名登录顺序：`cloudbase.init({ env })` → `app.auth({ persistence: 'local' })` → `anonymousAuthProvider().signIn()` → 再 `callFunction`
- 管理员鉴权只用 `adminAuth` 返回的 token，存 `sessionStorage`，不依赖小程序 openid

## 上传方式（任选一种）

### A. CloudBase 静态托管

1. 微信开发者工具 → 云开发控制台 → 环境 `ordering-d0gyct6z1ff2afebd`
2. 左侧「静态网站托管」→ 开通（首次）
3. 上传本目录全部文件到**根目录**（保持 `index.html` 在根目录）
4. 记下默认域名，形如 `https://<env-id>.tcloudbaseapp.com` 或控制台给出的 `xxx.tcloudbaseapp.com`

### B. GitHub Pages

1. 把 `index.html / app.js / style.css` 放到仓库某个目录（例如 `admin-console/`）
2. 仓库 Settings → Pages → 选择分支与目录 → 保存
3. 访问地址形如 `https://amy-sy0711.github.io/Smartatordering/admin-console/`

### C. 任意静态站

把三个文件上传到任意 HTTPS 静态服务器即可；单文件版 `admin-console-standalone.html` 可直接改名为 `index.html` 使用。

## 必须配置的两项（否则登录/调用会失败）

### 1. 开启匿名登录

微信开发者工具 → 云开发控制台 → 设置/环境设置 → 「登录方式」→ 开启**匿名登录**。

浏览器端调用云函数前需要匿名登录态；管理台本身不使用匿名 openid 做任何权限判断，只把它当作调用云函数的“入场券”。

### 2. 添加 Web 安全域名

云开发控制台 → 设置 → 「安全配置 / Web 安全域名」→ 添加部署后的域名：

- CloudBase 静态托管：`xxx.tcloudbaseapp.com`
- GitHub Pages：`amy-sy0711.github.io`
- 只填域名，不带 `https://`、不带路径
- 有端口时按控制台要求填写（通常不要端口）

## 首次管理员登录

1. 确认 `adminAuth` / `adminApi` 已部署为最新版本。
2. 在云函数环境变量中设置（`adminAuth`、`adminApi` 都要配）：
   - `ADMIN_TOKEN_SECRET`（至少 16 位随机串，两个函数用同一个值）
   - `ADMIN_BOOTSTRAP_PASSWORD`（首次创建管理员用，创建成功后建议删除）
3. **改完环境变量后必须重新部署云函数**（右键函数 → 上传并部署：云端安装依赖），否则运行实例可能仍读不到新变量。
4. 打开页面，环境 ID 已预填 `ordering-d0gyct6z1ff2afebd`；首屏「环境自检」会显示云函数可达 / 匿名登录态 / `admins` 集合 / 管理员数量 / 两个环境变量是否存在，失败项直接给修法。
5. 用户名建议填 `admin`，密码填 `ADMIN_BOOTSTRAP_PASSWORD` 的值。
6. `admins` 集合不存在时，云函数会在首次初始化时自动创建；已有管理员时返回 `ALREADY_INITIALIZED`，请用已有账号登录。
7. 登录成功后到「修复工具 → 修改管理员密码」设置正式密码，并删除环境变量 `ADMIN_BOOTSTRAP_PASSWORD`。

## 常见错误

登录失败时页面会原样显示 `code · message` 和 `hint`，并提供「复制错误信息」按钮；对照下表处理。

| 现象 / code | 原因 | 处理 |
| --- | --- | --- |
| `CloudBase JS SDK 未加载` | CDN 被拦截/断网 | 换网络，或把 SDK 下载到本地同目录并改 `index.html` 引用 |
| `ANONYMOUS_REQUIRED` / 「客户端匿名登录失败」 | 未开启匿名登录，或域名不在 Web 安全域名 | 开启匿名登录；设置 → 安全配置 → Web 安全域名（只填域名） |
| `ADMINS_COLLECTION_MISSING` | `admins` 集合不存在且没配初始口令 | 配置 `ADMIN_BOOTSTRAP_PASSWORD` 后重新部署；或控制台手动建集合 |
| `ENV_MISSING` | `admins` 为空且未配 `ADMIN_BOOTSTRAP_PASSWORD` | 云函数 `adminAuth` 环境变量新增该项，重新部署 |
| `TOKEN_SECRET_MISSING` | `ADMIN_TOKEN_SECRET` 未配置或不足 16 位 | `adminAuth`、`adminApi` 各配同一个 ≥16 位随机串，重新部署 |
| `INVALID_CREDENTIALS` | 首次密码与初始口令不一致；或已有账号密码错 | 核对环境变量（不要带空格/引号）；已有账号用原密码 |
| `ALREADY_INITIALIZED` | 已有管理员但用户名没匹配到（不是密码错） | 用已有管理员登录；确需重置：删除 `admins` 全部记录后重新部署 |
| `UNAUTHORIZED` / `TOKEN_INVALID` | token 过期、密钥轮换 | 重新登录；确认两个函数的 `ADMIN_TOKEN_SECRET` 一致 |
| `CALL_FUNCTION_FAILED` | 云函数未部署 / 环境 ID 不对 / 域名未加白 | 检查自检面板，逐项修复 |
| 浏览器 CORS 报错 | Web 安全域名未加 | 添加域名后刷新 |
