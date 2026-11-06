# 点餐小程序（多租户 SaaS）

微信小程序 + 微信云开发（CloudBase）实现的「今日菜单 + 在线点单 + 收款确认 + 打包清单 + 当日营收」。同一套代码可给多个商家使用，按 `merchantId` 隔离数据。

## 0. 三层后台与角色边界（先看这一节）

| 层级 | 使用者 | 能做什么 | 绝对不能做什么 |
| --- | --- | --- | --- |
| 小程序顾客端 | 顾客 | 看今日菜单、下单、查看自己的订单 | 进入商家端、看到别家菜单 |
| 小程序商家端 | 店主 / 店员 | 接单、出餐、确认收款、打包勾选、轻量菜单操作 | 进入平台后台、跨商家读写 |
| 网页商家后台 `merchant-console/` | 店主 | 菜单/分类、订单看板、打包、营收、员工、导出 CSV | 查看别家数据、进入平台后台 |
| 网页平台运营后台 `admin-console/` | 系统运营者（你） | 商家开通/停用、套餐/有效期占位、员工绑定、系统健康、错误聚合、修复工具、审计日志 | **查看任何商家业务明细**（订单内容、菜品内容、顾客信息、营收明细、备注、手机号、地址） |

平台管理员是系统运营者，不是商家。`adminApi` **不实现** `listOrders / listDishes / getOrderDetail` 这类接口；前端管理台也没有这些入口。若将来确有排障需要，只能走「商家授权临时令牌」流程（本期仅保留接口占位）。

所有管理写操作都会落 `audit_logs`：操作者、时间、action、目标 `merchantId`、结果、错误码、来源；日志本身不写业务字段值。商家导出 CSV 也只记录「谁、何时、导出了多少条」。

> 控制台根权限的现实风险：`admin-console` 的 token 一旦泄露，等同于平台运营权限。内部规范：只在自己的设备登录、退出即清 sessionStorage、定期轮换 `ADMIN_TOKEN_SECRET`、不要把初始密码发到群聊。

## 1. 快速开始（部署清单）

1. **导入工程**：微信开发者工具 → 导入项目 → 选择仓库根目录（不要只选 `miniprogram`）。
2. **确认环境 ID**：`miniprogram/app.js` 的 `CLOUD_ENV = 'ordering-d0gyct6z1ff2afebd'`，必须与云开发控制台的环境 ID **完全一致**。
3. **部署云函数**（右键目录 → 上传并部署：云端安装依赖）：
   - `api` → `pay` → `paynotify` → `init` → `adminAuth` → `adminApi` → `merchantAuth`
   - 每个目录都有 `package.json`（`wx-server-sdk`），不需要本地 npm 构建。
4. **配置云函数环境变量**（云开发控制台 → 云函数 → 对应函数 → 环境变量）：
   - `api` / `adminApi`：`ADMIN_TOKEN_SECRET`（至少 16 位随机串，管理员 token 签名密钥）
   - `api` / `merchantAuth`：`MERCHANT_TOKEN_SECRET`（可与 ADMIN 不同；未设置时回退用 `ADMIN_TOKEN_SECRET`）
   - `adminAuth` / `adminApi`：`ADMIN_BOOTSTRAP_PASSWORD`（仅在 `admins` 集合为空时用于创建第一个管理员，创建成功后该口令立即失效）
   - 不要把任何密钥写进代码或提交到仓库。
5. **初始化数据**：云开发控制台 → 云函数 `init` → 云端测试，入参 `{"action":"setup"}`。它会：
   - 建全部集合（幂等）；
   - 创建默认商家 `merchant_001`（`DEFAULT_MERCHANT_ID`）；
   - 给历史 `dishes / menus / orders / payment_records / counters` 补 `merchantId`，老数据不丢；
   - 写入默认支付配置、示例菜品与种子分类。
6. **创建第一个平台管理员**：打开 `admin-console/index.html`（部署方式见第 7 节），用 `ADMIN_BOOTSTRAP_PASSWORD` 对应的口令走首次初始化；之后在管理台改密。
7. **创建商家账号**：平台管理台 → 新建商家 → 生成 `merchantId` 与一次性初始密码 → 交给商家，让其在 `merchant-console/` 登录。
8. **绑定员工 openid**：商家在小程序里打开「我的」/身份信息拿到 openid，平台管理台或商家后台的「员工」页绑定到对应 `merchantId`。一个 openid 对应一个商家。
9. **重新编译小程序**：商家/店员启动直接进商家看板，顾客进菜单。

> 本项目**未在微信开发者工具或真机上实机运行**（开发环境未安装开发者工具）。上面的部署步骤必须由你在本地逐项执行并验证。

## 2. 多租户模型

- 一个商家一张店，`merchants` 的 `_id` 就是 `merchantId`。
- 所有业务集合（`dishes / categories / menus / orders / slot_counters / counters / settings / payment_records`）都带 `merchantId`。
- 云函数所有业务查询与写入都带 `merchantId` 过滤；不允许跨租户读写。商家端写操作的 `merchantId` 只从服务端身份（`merchant_staff` 或商家 token）取，**不信任前端传值**。
- 菜单文档 ID 按租户前缀：默认商家沿用 `m_YYYYMMDD`，其他商家为 `m_<merchantId>_YYYYMMDD`；订单号计数器、支付配置文档同理加租户前缀。
- 商家 `status` 为 `disabled` 时：禁止顾客下单、禁止商家写操作；管理台可以随时恢复。
- 分享卡片路径带 `mid=<merchantId>`。顾客从卡片进入即绑定当前商家；无 `mid` 时使用 `DEFAULT_MERCHANT_ID`；若配置了多个商家且都没有 `mid`，页面提示「请从商家分享的链接进入」并列出可用商家。

## 3. 目录结构

```
.
├── project.config.json
├── miniprogram/
│   ├── app.js / app.json / app.wxss / sitemap.json
│   ├── components/                 # spec-picker / pay-panel / merchant-exit
│   ├── pages/
│   │   ├── entry/                  # 启动身份识别与分流（whoami 四角色）
│   │   ├── menu/ cart/ orders/ order-detail/
│   │   ├── diagnose/               # 环境自检（仅平台管理员可进，非管理员直达会被拦回菜单）
│   │   └── merchant/               # index / menu / dish / board / packing / stats / settings
│   └── utils/
│       ├── data-source.js          # 唯一数据入口：cloud / local 分流
│       ├── merchant-context.js     # 捕获分享卡片 mid，保存当前商家
│       ├── role-router.js          # 启动分流纯逻辑（可单测）
│       ├── merchant-guard.js       # 商家页角色守卫（非商家 reLaunch 回菜单）
│       ├── safe.js                 # 展示层兜底 safeText / safeNumber / safeInt / safeArray
│       ├── menu-cache.js           # 菜单快照缓存失效
│       └── local-backend.js        # 本地演示后端（纯 JS，可单测）
├── cloudfunctions/
│   ├── api/                        # 业务唯一入口（action 白名单 + 租户隔离）
│   ├── pay/ paynotify/             # 支付与回调
│   ├── init/                       # 建集合、默认商家、迁移旧数据、种子数据
│   ├── adminAuth/ adminApi/        # 平台运营后台（token 鉴权，无业务读接口）
│   └── merchantAuth/               # 商家网页后台登录（账号密码 → 商家 token）
├── admin-console/                  # 平台运营后台（纯静态 HTML + CDN SDK）
├── merchant-console/               # 商家网页后台（纯静态 HTML + CDN SDK）
├── tests/
│   ├── run-tests.js                # 离线纯逻辑单测
│   └── static-check.js             # JS/JSON/页面/集合/租户隔离/后台边界静态校验
├── README.md
└── ACCEPTANCE.md
```

## 4. 数据字典

金额字段一律为**整数分**（`priceCents / totalCents / amountCents`），展示时才格式化为元。

### merchants（商家/租户）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | `merchantId` |
| `name` | string | 店名 |
| `status` | string | `active` / `disabled` |
| `contact` | string | 联系方式（仅租户元信息） |
| `loginUsername` | string | 商家后台登录账号（默认等于 merchantId） |
| `passwordHash` | string | scrypt 加盐哈希，不存明文 |
| `plan` / `expiresAt` | string/date | 套餐/有效期占位字段 |
| `flags` | object | 功能开关：`disableOrdering` / `pickupOnly` / `maxConcurrentOrders` |
| `settingsRef` | string | 支付配置文档 ID：默认商家 `payment`，其他 `payment_<merchantId>` |
| `tokenRevokedAt` | date | 吊销早于该时间签发的商家 token |
| `createdAt` / `updatedAt` | date | 时间戳 |

### merchant_staff（商家员工绑定）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | openid |
| `merchantId` | string | 所属商家 |
| `merchantIds` | array | 预留：一人多店（本期只取第一个） |
| `role` | string | `owner` / `staff` |
| `name` | string | 员工称呼 |
| `createdAt` | date | 绑定时间 |

### admins（平台管理员）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | adminId |
| `username` | string | 登录名 |
| `passwordHash` | string | scrypt 加盐哈希 |
| `openid` | string | 可选：绑定小程序 openid 后可在 `pages/diagnose` 查看自检 |
| `createdAt` | date | 创建时间 |

### categories（菜品分类）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | 分类 ID |
| `merchantId` | string | 所属商家 |
| `name` | string | 分类名（1-12 字） |
| `sort` | int | 升序，小在前 |
| `enabled` | bool | 禁用后顾客端不展示、菜单管理仍可见 |
| `createdAt` / `updatedAt` | date | 时间戳 |

### dishes（菜品库）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | 菜品 ID |
| `merchantId` | string | 所属商家 |
| `name` / `category` | string | 名称 / 分类 |
| `priceCents` | int | 基础价（分） |
| `imageUrl` | string | 云存储 fileID 或图片 URL，可空 |
| `specs` | array | `[{id,name,required,options:[{id,label,priceDeltaCents}]}]` |
| `sortOrder` | int | 排序 |
| `onSale` / `soldOut` | bool | 上架 / 售罄 |
| `createdAt` / `updatedAt` | date | 时间戳 |

### menus（每日已发布菜单）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` / `menuId` | string | `m_YYYYMMDD`（多租户加前缀） |
| `merchantId` / `date` | string | 商家 / `YYYY-MM-DD`（Asia/Shanghai） |
| `title` | string | 菜单标题 |
| `dishIds` | array | 当日菜品 ID 列表 |
| `slots` | array | `[{id:"s1", label:"11:30-12:00", limit:20}]` |
| `published` | bool | 是否已发布 |
| `menuVersion` / `updatedAt` | int/date | 发布版本号；保存菜品/发布时更新，用于失效客户端菜单缓存 |
| `publishedBy` | string | 发布人 openid |
| `createdAt` | date | 时间戳 |

> 「菜品库」与「今日已发布菜单」不是一回事：菜品加了但没有勾选进今日菜单，顾客端不会显示。商家后台菜单页明确分开这两块，并提供「加入今日菜单」操作。

### orders（订单）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` / `orderNo` | string | 订单号 `YYYYMMDD-0001`，`_id` 与 `orderNo` 相同 |
| `merchantId` / `date` / `menuId` | string | 商家 / 自然日 / 所属菜单 |
| `buyerOpenid` | string | 下单人 |
| `items` | array | 菜品快照 |
| `totalCents` / `totalQty` | int | 合计金额（分）/ 总份数（服务端重算） |
| `status` | string | 见第 6 节状态机 |
| `payChannel` | string | `transfer` / `jsapi` / `mock` |
| `transactionId` | string | 支付交易号 |
| `paidAt` / `transferredAt` / `confirmedAt` | date/null | 支付/转账/确认收款时间 |
| `transferNote` / `remark` | string | 转账备注 / 顾客备注 |
| `confirmedBy` | string | 确认收款的商家 openid |
| `pickupSlot` | object | `{id,label}` 取餐时段快照 |
| `packed` / `packedAt` | bool/date | 打包勾选 |
| `statusHistory` | array | `[{status,at,by}]` |
| `createdAt` / `updatedAt` | date | 时间戳 |

### slot_counters（时段名额计数）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | `<menuId>__<slotId>`（menuId 已含租户前缀） |
| `menuId` / `slotId` / `label` / `date` | string | 归属 |
| `limit` / `used` | int | 限量 / 已占用（条件自增，防超卖） |

### counters（订单号计数器）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | `seq_YYYYMMDD`（多租户加前缀） |
| `date` / `seq` | string/int | 日期 / 当日序号 |

### settings（支付配置，按商家）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | `payment` 或 `payment_<merchantId>` |
| `merchantId` | string | 所属商家 |
| `payMode` | string | `transfer`（默认）/ `jsapi` / `mock` |
| `transfer.qrImageUrl` / `payeeName` / `tipText` | string | 转账收款信息 |
| `updatedAt` / `updatedBy` | date/string | 修改时间 / 操作人 |

### payment_records（收款记录）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | `pr_<orderId>`，同一订单只确认一次 |
| `merchantId` / `orderId` / `orderNo` / `date` | string | 归属 |
| `amountCents` | int | 收款金额（分） |
| `channel` | string | `transfer` / `jsapi` |
| `operatorOpenid` | string | 操作人 |
| `at` / `createdAt` | date | 确认时间 |

### merchant_admins（旧版白名单，仅兼容）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | 固定 `merchant_admins` |
| `openids` | array | 旧版静态白名单；新流程请用 `merchant_staff` |

### audit_logs（审计日志）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | 自动 ID |
| `actorType` / `actorId` / `actorName` | string | 操作者类型/ID/名称 |
| `action` | string | 操作名 |
| `merchantId` | string | 目标租户（平台级操作可空） |
| `result` / `code` | string | `ok` / `fail` 与错误码 |
| `source` | string | 来源（如 `admin-console`） |
| `at` | date | 时间 |

### error_logs（错误日志）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `action` / `code` / `merchantId` | string | 出错动作 / 错误码 / 租户 |
| `at` | date | 时间 |

> `error_logs` 只记录动作、错误码、租户与时间，不记录参数中的业务字段。

### 建议索引
| 集合 | 索引字段 |
| --- | --- |
| `orders` | `merchantId` + `date` + `createdAt`（降序）；`merchantId` + `buyerOpenid` + `createdAt`（降序）；`merchantId` + `date` + `status` |
| `dishes` | `merchantId` + `sortOrder` |
| `categories` | `merchantId` + `sort` |
| `menus` | `merchantId` + `date`（降序） |
| `payment_records` | `merchantId` + `date` + `at`（降序） |
| `merchant_staff` | `merchantId` |
| `audit_logs` / `error_logs` | `at`（降序） |

## 5. 云函数接口

### `api`（小程序与商家后台统一业务入口）
入参 `{ action, payload }`，返回 `{ code, data }`；`code !== 0` 时 `message` 可直接展示。

四类角色 action 白名单（`cloudfunctions/api/core/action-policy.js`）：

- `customer`：`whoami`、`menu.today`、`settings.payment`、`order.create`、`order.list`、`order.detail`、`order.markTransferred`、`order.cancel`、`order.reorder`、`merchant.checkAccess`、`merchant.claimSelf`
- `staff`：顾客全部 + `merchant.listDishes`、`merchant.menuHistory`、`merchant.menuDetail`、`merchant.orders`、`merchant.transition`、`merchant.confirmReceipt`、`merchant.packing`、`merchant.setPacked`、`merchant.stats`、`merchant.getPaymentSettings`、`merchant.listCategories`
- `owner`：staff 全部 + 菜品/分类增删改、菜单发布/复制、收款设置、员工绑定/解绑、订单导出
- `admin`：仅 `whoami`、`health`

越权直接返回 `FORBIDDEN` 并写 `error_logs`。下单仍做服务端价格重算、菜单/上架/售罄校验、规格校验、时段条件自增、订单号防重。

### `adminAuth`
- `login`：用户名 + 密码 → `{ token, admin }`
- `verify`：校验 token
- 首次初始化：`admins` 为空时可用 `ADMIN_BOOTSTRAP_PASSWORD` 创建第一个管理员

### `adminApi`（平台运营后台，所有 action 先验 token）
- 商家：`merchant.list`、`merchant.create`、`merchant.update`、`merchant.setStatus`、`merchant.setFlags`、`merchant.resetPassword`
- 员工：`staff.list`、`staff.bind`、`staff.unbind`
- 健康/日志：`health`、`audit.list`、`error.summary`
- 修复：`repair.rebuildIndexes`、`repair.seedDefaults`、`repair.cleanOrphans`、`repair.resetStaff`、`repair.revokeTokens`、`repair.refreshMenuCache`、`repair.resendPaymentCallback`
- 管理员：`admin.changePassword`
- **不提供业务读取接口**，也不返回订单/菜品/顾客内容；只返回租户元信息、计数与状态。

### `merchantAuth`
- `login`：商家账号 + 密码 → 商家 token（含 `merchantId`、过期时间）
- `verify`：校验 token 与商家状态

### `init`
- `setup`：建集合、创建默认商家、补历史数据 `merchantId`、写种子菜品与分类（幂等）

## 6. 订单状态机

```
pending_pay ──「我已转账」──> pending_confirm ──商家确认收款──> paid
pending_pay ──mock / jsapi 支付成功────────────────────────> paid
paid ──接单──> accepted ──出餐──> ready ──完成──> completed
pending_pay / pending_confirm / paid / accepted / ready ──取消──> canceled（终态）
```

仅 `paid` 可接单。已收款订单取消记为退款口径；收益里单列退款金额。

## 7. 平台运营后台（`admin-console/`）

纯静态：`index.html` + `app.js` + `style.css`，CDN 引 `@cloudbase/js-sdk` 匿名登录，无 npm 构建。

### 部署
1. CloudBase 静态托管：把 `admin-console/` 三个文件上传到一个静态站点目录，记下访问域名。
2. 或 GitHub Pages：把该目录作为 Pages 根目录发布（或用 `/admin-console/` 子路径）。
3. 云开发控制台 → 环境 → 安全配置 → **Web 安全域名**：加入控制台域名（GitHub Pages 也要加）。
4. 云函数环境变量：`ADMIN_TOKEN_SECRET`、`ADMIN_BOOTSTRAP_PASSWORD`（首次初始化后失效）。
5. 打开页面，填环境 ID `ordering-d0gyct6z1ff2afebd`，用管理员账号登录。

### 能做什么
- 商家列表（搜索 / 状态 / 今日订单数 / 员工数）
- 新建商家（生成 `merchantId` + 一次性初始密码）、编辑、启用/停用、套餐/有效期占位、功能开关
- 员工绑定/解绑（直接输入 openid）
- 系统健康：云函数可达性、集合存在性与文档数、默认商家状态、支付模式、今日菜单是否发布、最近 24h 错误码分布
- 修复工具：重建索引提示、补默认配置、清理孤儿员工绑定、重置员工绑定、吊销商家 token、强制刷新菜单缓存、重发支付回调（均为按 ID 的盲操作，只返回条数/成功失败）
- 审计日志、错误聚合、管理员改密

### 不能做什么
- 不能看订单明细、菜品内容、顾客信息、营收明细、备注、手机号、地址；页面与 `adminApi` 都没有这些接口。
- 不能进入商家端小程序或商家网页后台。

### 初始化管理员
`admins` 集合为空时，首次 `adminAuth.login` 使用 `ADMIN_BOOTSTRAP_PASSWORD` 创建管理员；创建成功后该环境变量即失效（请随后在管理台改密并删除该环境变量）。

## 8. 商家网页后台（`merchant-console/`）

纯静态：`index.html` + `app.js` + `style.css`，CDN 引 `@cloudbase/js-sdk` 匿名登录。

### 部署
与平台后台相同：静态托管 / GitHub Pages + Web 安全域名。环境变量需要 `MERCHANT_TOKEN_SECRET`（或 `ADMIN_TOKEN_SECRET` 回退）。

### 登录
平台创建商家时生成一次性初始密码，商家用「账号（`loginUsername`）+ 密码」登录；商家 token 存 `sessionStorage`，退出即清。

默认商家 `merchant_001` 由 `init setup` 创建时没有密码。要登录它，先在平台管理台「重置密码」生成一次性初始密码；或直接在小程序用该 openid 进入商家看板（`merchant_staff` 已在初始化时绑定）。

### 能做什么
- 菜单：菜品库增删改、上下架/售罄、今日菜单勾选发布（标题 + 取餐时段）、从历史复制
- 分类：新增/重命名/删除/上移下移/启用停用
- 订单看板：确认收款、接单、出餐、完成、取消
- 打包：按取餐时段聚合 + 逐单勾选
- 营收：当日汇总 + 销量排行
- 员工：绑定/解绑 openid
- 导出 CSV：仅导出本租户订单，导出动作写审计（只记条数）

所有请求都带商家 token；服务端按 token 中的 `merchantId` 过滤，前端传的 `merchantId` 一律忽略。

## 9. 权限与租户隔离规则

1. **入口拦截**：`api` 先解析身份（`platform_admin / merchant_owner / merchant_staff / customer`），再按 action 白名单拒绝越权。
2. **归属校验**：商家端写操作除白名单外，还在 handler 内校验「该 openid / token 属于该 `merchantId`」与 `role`。
3. **查询过滤**：所有业务集合查询带 `merchantId`；按 `_id` 取单条时也要求 `_id + merchantId` 同时命中。
4. **订单归属**：顾客只能看自己的订单；商家只能看本租户订单。
5. **商家状态**：`disabled` 时服务端拒绝下单与写操作，前端给出提示。
6. **平台后台**：`adminApi` 禁止业务读取；静态检查会扫描业务集合读调用与业务字段。
7. **小程序商家页**：每个页面 `onLoad` 调 `merchant-guard`；非商家 `wx.reLaunch` 回菜单并 toast「无商家权限」。平台管理员也不会被放进商家端。
8. **顾客端**：没有任何进入商家端的按钮、图标或隐藏跳转。

## 10. 迁移旧数据

1. 部署新版 `init`。
2. 云端测试执行 `{"action":"setup"}`：
   - 创建 `merchants` 默认商家 `merchant_001`；
   - 给旧 `dishes / menus / orders / payment_records / counters` 补 `merchantId=merchant_001`；
   - 给 `settings/payment` 补 `merchantId`；
   - 写入种子分类（若 `categories` 为空）。
3. 旧菜单 ID `m_YYYYMMDD` 继续有效（默认商家沿用旧 ID），旧订单仍可查。
4. 旧 `merchant_admins.openids` 不会被自动迁移为员工；请在管理台/商家后台按 openid 重新绑定到 `merchant_staff`。
5. 执行后检查 `init` 返回的 `migrated` 计数；如有异常，先在测试环境验证。

## 11. 配置商家与员工

- **平台管理员**（系统运营者）：`admins` 集合，通过 `admin-console` 登录，只管理系统，不看业务数据。
- **商家 owner/staff**：`merchant_staff` 集合，`_id = openid`，字段 `merchantId / role(owner|staff) / name`。可用平台管理台或商家网页后台绑定。
- 店员不能做菜品/分类/菜单发布/收款设置/员工管理，只能接单、出餐、打包、看统计。
- 老板自己点单：商家看板顶部「查看顾客端」（`from=merchant`，顾客端顶部显示「商家预览中」，可一键返回看板）。

## 12. 支付方式

配置来源：`settings` 集合的 `payment`（默认商家）或 `payment_<merchantId>`（其他商家），商家后台「收款设置」可改。

| payMode | 行为 |
| --- | --- |
| `transfer`（默认） | 下单后 `pending_pay`，展示收款信息；顾客点「我已转账」→ `pending_confirm`；商家确认 → `paid` |
| `jsapi` | 下单后调 `cloudPay.unifiedOrder`，前端 `wx.requestPayment`，`paynotify` 回调置 `paid`；未配置商户号时明确报错、不白屏 |
| `mock` | 仅开发调试：订单页「模拟支付」后置 `paid` |

切换到真实微信支付：在 `cloudfunctions/pay/config.js` 与 `cloudfunctions/api/config.js` 同步修改 `WXPAY`（`ENABLED / SUB_MCH_ID / ENV_ID / BODY_PREFIX`，两处必须一致），重新部署 `pay`、`api`；代码中不写死任何密钥/商户号。支付配置按订单所属租户读取。

## 13. 本地演示模式（仅开发调试）

- `miniprogram/app.js` 的 `DATA_MODE = 'cloud'`；改为 `'local'` 或写入 storage 键 `ordering_data_mode=local` 才进入本地演示。
- 商家端与顾客端**没有**切换入口；切换只保留在管理台/开发配置。
- local 模式下商家与顾客读写同一个本地 store（同一 key、同一版本）。
- 云端失败时**不会**自动切 local：明确提示「云端不可用：<code> <message>」并提供「重试 / 关闭」；只有开发者在配置里显式切 local 才会进入本地模式。进入 local 后页面顶部常驻橙色横幅「本地演示模式：数据不会同步到云端，其他人看不到」。

## 14. 验证

```bash
node tests/run-tests.js       # 离线纯逻辑单测（金额/时段/状态机/租户/角色/token/分类/导出）
node tests/static-check.js    # JS 语法、JSON、页面、组件、集合、租户隔离、后台边界
```

静态检查包括：
- 所有 JS `node --check`、所有 JSON 可解析；
- 页面四件套与 usingComponents 存在；
- README 包含全部集合名、init 包含全部集合；
- 金额路径不含 `parseFloat / toFixed`；
- ASI 隐患（对象字面量下一行以 `(`/`[` 开头）；
- 模板高风险三元表达式提示；
- 商家页必须接入角色守卫；
- `adminApi / admin-console` 不得出现业务读取接口或业务明细字段；
- 商家后台不得调用 `adminApi` / 使用管理员 token；
- 两个控制台引用的云函数目录必须存在；
- `pages/diagnose` 必须仅平台管理员可进、无 `goDiagnose` 残留入口；
- 云函数业务查询必须带 `merchantId`（或按租户前缀文档 ID 存取）。

## 15. 常见问题与修复建议

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 云函数未抵达 / `INTERNAL_ERROR` | 未部署 `api`、环境 ID 不一致、云函数目录名与 `callFunction` 的 `name` 不一致、混用旧版 success/fail | 重新部署；确认 `CLOUD_ENV=ordering-d0gyct6z1ff2afebd`；确认调用名 `api`；统一用 Promise 写法 |
| 顾客端看不到新菜 | 菜品只加进「菜品库」，未加入今日菜单；菜单缓存未失效 | 商家后台菜单页勾选并发布今日菜单；保存后会自动刷新缓存与菜单版本 |
| 「剩undefined」 | 旧时段数据缺 `limit` 或字段名不一致 | 新版 `readSlots` 已兜底；建议在商家后台重新保存取餐时段 |
| 商家登录 401 / `TOKEN_INVALID` | `MERCHANT_TOKEN_SECRET` 未设置、token 过期、被吊销 | 检查 env 变量；重新登录；管理台「吊销令牌」后需重新登录 |
| 管理员登录失败 | `admins` 集合不存在、环境变量未生效、密码错误 | 先看管理台首屏「环境自检」，再按 15.1 的登录排障表逐项处理 |
| 管理台跨域 / 匿名登录失败 | 未把控制台域名加入 Web 安全域名 | 云开发控制台 → 环境 → 安全配置 → Web 安全域名 |
| 商家停用后仍能下单 | 旧订单/缓存 | 服务端已校验 `merchants.status`；刷新页面后重试 |

### 15.1 管理台登录失败排障（`adminAuth`）

管理台首屏有「环境自检」面板（云函数可达 / 匿名登录态 / `admins` 集合 / 管理员数量 / 两个环境变量是否存在），失败项直接显示修法；登录失败会原样显示 `code · message` 和 `hint`，可点「复制错误信息」。

| 现象 / 错误码 | 原因 | 修法 |
| --- | --- | --- |
| `INTERNAL_ERROR`，日志含 `-502005 collection not exists` | 云开发不会自动建集合，`admins` 不存在时 `count()` 直接抛错，旧版把它吞成通用错误 | 最新版 `adminAuth` 在首次初始化时会自动建集合；若仍失败，控制台 → 数据库 → 新建集合 `admins` |
| `ADMINS_COLLECTION_MISSING` | 集合不存在，且没配初始口令，无法自动创建 | 配置 `ADMIN_BOOTSTRAP_PASSWORD` 后重新部署；或手动建集合 |
| `ENV_MISSING` | `admins` 为空且未配 `ADMIN_BOOTSTRAP_PASSWORD` | 云开发控制台 → 云函数 → `adminAuth` → 环境变量，新增该项 |
| `TOKEN_SECRET_MISSING` | 未配 `ADMIN_TOKEN_SECRET` 或长度 < 16，密码正确也签不出 token（旧版会先写库再失败，留下无法登录的管理员） | `adminAuth` 与 `adminApi` 都配同一个 ≥16 位随机串；新版会先校验密钥再写库 |
| `INVALID_CREDENTIALS` | 首次初始化时密码与 `ADMIN_BOOTSTRAP_PASSWORD` 不一致；或已有账号密码错 | 核对环境变量值（不要带空格/引号）；已有账号请输入原密码 |
| `ALREADY_INITIALIZED` | `admins` 已有记录，但输入的用户名没有匹配到（不是密码错） | 用已有管理员账号登录；确需重置：控制台删除 `admins` 全部记录 → 重新部署 → 用初始口令创建 |
| `ANONYMOUS_REQUIRED` / 页面显示「客户端匿名登录失败」 | 未开启匿名登录，或当前域名不在 Web 安全域名 | 设置 → 登录方式 → 匿名登录；设置 → 安全配置 → Web 安全域名（只填域名，不带路径） |
| 页面只有「登录失败」四个字 | 旧前端把 SDK reject 对象的 `message` 取空后用了兜底文案 | 换用最新 `deploy/admin-console/` 或 `deploy/admin-console-standalone.html` |
| 自检全绿但仍登录失败 | 用户名/密码确实不对，或云端跑的还是旧版云函数 | 点「复制错误信息」看具体 code；对 `adminAuth` 重新部署 |

**改环境变量后必须重新部署云函数**：在云开发控制台改完「环境变量」后，对 `adminAuth`（涉及 token 的还有 `adminApi`）执行一次「上传并部署：云端安装依赖」，确保新变量注入运行实例；否则可能仍跑在旧实例上读不到 `ADMIN_BOOTSTRAP_PASSWORD` / `ADMIN_TOKEN_SECRET`。

## 16. 已知限制

- **未实机运行**：本项目没有在微信开发者工具/真机上运行过，部署、渲染、支付调起需你本地验证。
- 管理台/商家后台为纯静态页，依赖 CloudBase JS SDK 匿名登录；若环境未开匿名登录需在控制台开启。
- 一人管多店只预留 `merchantIds` 字段，本期按单商家处理。
- 「商家授权临时令牌」仅保留接口占位，未实现完整 UI。
- `repair.rebuildIndexes` 只能检测并返回缺失索引提示，云开发 API 不支持在云函数内直接建索引，需到控制台手动创建。
