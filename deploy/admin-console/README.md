# 平台运营后台部署包（deploy/admin-console）

本目录包含部署所需文件（`deploy/admin-console.zip` 与之一一对应）：

```
admin-console.zip
├─ index.html
├─ app.js
├─ style.css
├─ login-state.js          # 登录按钮状态机（loading 反馈）
└─ vendor/
   └─ cloudbase.full.js    # CloudBase Web SDK 2.17.5（本地固化，离线可用）
```

上传时**保持这个层级**：`index.html` 在站点根目录，`vendor/` 与它同级。

同一份单文件版本在上一级：`deploy/admin-console-standalone.html`（CSS / JS / SDK 全部内联，约 600 KB，可直接改名 `index.html` 丢到任意静态托管，适合离线或 CDN 被墙的环境）。

页面已固定：

- 环境 ID：`ordering-d0gyct6z1ff2afebd`
- CloudBase JS SDK：本地 `./vendor/cloudbase.full.js`（2.17.5，**不再依赖 CDN**）
- 匿名登录顺序：`cloudbase.init({ env })` → `app.auth({ persistence: 'local' })` → `anonymousAuthProvider().signIn()` → 再 `callFunction`；匿名登录失败会直接中断，不会继续调用云函数
- 管理员鉴权只用 `adminAuth` 返回的 token，存 `sessionStorage`，不依赖小程序 openid

## 打开方式（必须 http/https）

**不能直接双击 `index.html`**（`file://` 下匿名登录请求会被拒）。本地预览任选其一：

```bash
# 方式一
npx serve .

# 方式二
python -m http.server 8000
```

然后访问 `http://localhost:8000/`。部署到线上时用 HTTPS 地址，例如：

- CloudBase 静态托管：`https://<env-id>.tcloudbaseapp.com/`
- GitHub Pages：`https://amy-sy0711.github.io/Smartatordering/admin-console/`

> 注意：即使页面通过 http://localhost 打开，匿名登录仍可能失败——`localhost` 也需要加入 Web 安全域名（或改用已加白的线上域名验证）。页面顶部会显示当前 `location.origin`，并提供「复制当前域名」按钮，直接粘进白名单即可（只填域名，不要 `https://`、不要路径）。

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

登录失败时页面会原样显示 `code · message` 和 `hint`，并提供「复制错误信息」按钮；顶部还会显示环境域名探测的 HTTP 状态码。

**先分两大类，不要混为一谈：**

- **脚本没加载**：Console 报 `cloudbase is not defined` 或页面横幅提示「SDK 加载失败」→ 本地文件缺失/路径不对，**与云开发白名单无关**。
- **服务端返回 400**：Console 有红色 `Failed to load resource: 400 (Bad Request)`，URL 以 `ordering-d0gyct6z1ff2afebd` 开头 → 匿名登录请求被拒，**是 Web 安全域名/匿名登录配置问题**，换本地 SDK 也修不好。

| 现象 | 原因 | 修法 |
| --- | --- | --- |
| `cloudbase is not defined` / 横幅「SDK 加载失败」 | `vendor/cloudbase.full.js` 没上传、路径层级不对，或用了旧的 CDN 引用 | 保持 `index.html` 与 `vendor/` 同级上传；或直接用单文件版（SDK 已内联）；F12 Network 看该文件是否 404 |
| Console `400 (Bad Request)`，URL 含 `ordering-d0gyct6z1ff2afebd` | 匿名登录请求被拒：Web 安全域名不含当前域名，或未开启匿名登录 | 云开发控制台 → 设置 → 安全配置 → Web 安全域名，添加 **只填域名**（如 `amy-sy0711.github.io`，不带 `https://`、不带 `/Smartatordering/...`）；设置 → 登录方式 → 开启匿名登录；保存后刷新（等 1 分钟生效） |
| `ANONYMOUS_AUTH_DISABLED` | 匿名登录未开启 | 同上第二步：设置 → 登录方式 → 匿名登录 |
| 日志 `-502005 collection not exists` | `admins` 集合不存在（云开发不会自动建集合） | 新版 `adminAuth` 首次初始化会自动创建；仍失败则控制台 → 数据库 → 新建集合 `admins` |
| `ANONYMOUS_REQUIRED` | 匿名登录态没拿到（多为 400/403 的后续表现） | 看页面上的 HTTP 状态码与请求 URL，按 400 那条处理 |
| `ADMINS_COLLECTION_MISSING` | 集合不存在且没配初始口令 | 配置 `ADMIN_BOOTSTRAP_PASSWORD` 后重新部署；或控制台手动建集合 |
| `ENV_MISSING` | `admins` 为空且未配 `ADMIN_BOOTSTRAP_PASSWORD` | 云函数 `adminAuth` 环境变量新增该项，重新部署 |
| `TOKEN_SECRET_MISSING` | `ADMIN_TOKEN_SECRET` 未配置或不足 16 位 | `adminAuth`、`adminApi` 各配同一个 ≥16 位随机串，重新部署 |
| `INVALID_CREDENTIALS` | 首次密码与初始口令不一致；或已有账号密码错 | 核对环境变量（不要带空格/引号）；已有账号用原密码 |
| `ALREADY_INITIALIZED` | 已有管理员但用户名没匹配到（不是密码错） | 用已有管理员登录；确需重置：删除 `admins` 全部记录后重新部署 |
| `UNAUTHORIZED` / `TOKEN_INVALID` | token 过期、密钥轮换 | 重新登录；确认两个函数的 `ADMIN_TOKEN_SECRET` 一致 |
| `CALL_FUNCTION_FAILED` | 云函数未部署 / 环境 ID 不对 / 域名未加白 | 检查自检面板，逐项修复 |
| `file://` 横幅 | 直接双击打开 | 用 `npx serve .` 或 `python -m http.server 8000`，访问 `http://localhost:8000/` |
| 点了登录完全没反应 | 旧版页面脚本在绑定事件前就因 SDK 缺失抛错 | 用本目录最新版本：事件绑定前有初始化 try/catch + 全局错误区（含文件名/行号），按钮点击会立刻进入「登录中…」 |
