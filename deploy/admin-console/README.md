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

1. 确认 `adminAuth` / `adminApi` 已部署。
2. 在云函数环境变量中设置：
   - `ADMIN_TOKEN_SECRET`（至少 16 位随机串）
   - `ADMIN_BOOTSTRAP_PASSWORD`（首次创建管理员用，创建成功后失效）
3. 打开页面，环境 ID 已预填 `ordering-d0gyct6z1ff2afebd`。
4. 用户名可自定义（建议先用 `admin`），密码填 `ADMIN_BOOTSTRAP_PASSWORD` 的值。
5. 登录成功后系统自动创建第一个管理员；之后请到「修复工具 → 修改管理员密码」设置正式密码，并删除环境变量 `ADMIN_BOOTSTRAP_PASSWORD`。

## 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `CloudBase JS SDK 未加载` | CDN 被拦截/断网 | 换网络或把 SDK 下载到本地同目录并改 `index.html` 引用 |
| 登录报 `UNAUTHORIZED` / `TOKEN_INVALID` | `ADMIN_TOKEN_SECRET` 未配置或已轮换 | 检查 `adminAuth`、`adminApi` 两个函数的环境变量 |
| 登录报匿名相关错误 | 未开启匿名登录 | 按上文「登录方式」开启 |
| 浏览器 CORS / 域名错误 | Web 安全域名未加 | 按上文添加域名，保存后刷新 |
| `BOOTSTRAP_DISABLED` | `admins` 已有数据且用户名不存在 | 用已有管理员账号登录；或先在数据库确认 `admins` 记录 |
