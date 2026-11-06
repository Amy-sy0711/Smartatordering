# 微信群点餐小程序 MVP（原生小程序 + 微信云开发）

用小程序的「今日菜单 + 在线点单 + 收款确认 + 打包清单 + 当日收益」替代群接龙：顾客自己选菜下单，商家按下单顺序接单出餐，收款与对账有记录可查。支付方式可在云端配置为 **转账收款（默认）/ 微信支付 jsapi / 模拟支付 mock**。

支持两种数据模式：`cloud`（微信云开发，默认）与 `local`（本地演示，免云开发）。所有页面统一走 `miniprogram/utils/data-source.js`，页面里不判断模式。

## 0. 快速体验（三步）

1. **导入**：微信开发者工具 → 导入项目 → 选择本目录（不要只选 `miniprogram`）。
2. **编译**：点「编译」。启动页会调用 `whoami` 自动识别身份——商家直接进「订单看板」，其他人进「今日菜单」。看不到菜单或身份校验失败时，进「自检」页。
3. **成为商家并发菜单**：自检页复制你的 openid → 加入 `merchant_admins.openids`（或 `cloudfunctions/api/config.js` 的 `MERCHANT_OPENIDS`）→ 重新编译 → 自动进入商家看板 → 菜单管理 → 发布今日菜单。

> 云开发环境 ID 已写入 `miniprogram/app.js`：`CLOUD_ENV = 'ordering-d0gyct6z1ff2afebd'`，`onLaunch` 中执行 `wx.cloud.init({ env: CLOUD_ENV, traceUser: true })`。
> 不想开云开发时，可在「自检」页点「切换到本地演示模式」，完整流程离线可跑（见第 12 节）。

## 1. 做到什么程度

- ✅ 完整工程已生成，可直接导入微信开发者工具（`project.config.json` 已配好 `miniprogramRoot` / `cloudfunctionRoot`）。
- ✅ 启动自动身份识别与分流（`entry` 页 → `whoami` → 商家看板 / 顾客菜单），顾客端没有手动「商家入口」。
- ✅ 顾客端：今日菜单（分类分组、售罄置灰禁加购）、规格弹层、购物车结算（时段限量、备注、金额）、下单支付、订单详情、我的订单、再来一单、转发群卡片。
- ✅ 商家端：菜单管理与发布（从历史复制）、菜品增删改/上下架/售罄、订单看板（确认收款/接单/出餐/完成/取消）、打包清单（聚合 + 逐单勾选 + 复制文字）、当日收益（已收款/待确认/待付款/退款 + 销量排行 + 收款记录）、收款设置、环境自检。
- ✅ 云函数：`api`（全部读写 + `health` / `whoami`）、`pay`（mock/jsapi）、`paynotify`（支付回调）、`init`（建集合 + 种子数据）。
- ✅ 本地演示模式：`wx storage` 持久化 + 复用 `core` 纯逻辑，免云开发可跑通全流程。
- ✅ 离线单测与静态校验脚本已通过（见第 9 节）。
- ⚠️ **未在微信开发者工具中实机运行**（本机未安装开发者工具），以下必须由你自行验证：云函数部署、集合创建、真机/模拟器页面渲染、图片上传、转发卡片、真实微信支付调起。

**必须由你配置的项**：AppID（已改为 `wxa1c01ec63c3d4e59`）、开通云开发、部署 4 个云函数并执行一次 `init`、商家 openid 白名单（显式配置，不再自动把第一个访问者设为商家）。默认 `payMode=transfer`，不需要商户号即可完整跑通下单→转账→确认收款→打包→收益。

## 2. 启动流程（登录 → whoami → 分流）

```
小程序启动
   │
   ▼
pages/entry/entry（显示「正在识别身份…」）
   │  data-source.whoami() → cloud: 云函数 api { action: 'whoami' }
   │                          local: 本地标记
   ▼
返回 { openid, isMerchant }
   │
   ├── isMerchant === true  ─────────────► pages/merchant/index/index（商家订单看板）
   │                                         └ 顶部「← 切换到顾客端」（老板自己也能点单）
   │
   ├── isMerchant === false ─────────────► pages/menu/menu（顾客端今日菜单）
   │                                         └ 身份正常：无任何商家入口
   │
   └── 调用失败 / 云端不可达 ─────────────► pages/menu/menu
                                             └ 顶部横幅「身份校验失败，点此自检」
                                               （不白屏、不误进商家端）
```

身份判定来源（优先级从高到低）：

1. `cloudfunctions/api/config.js` 的 `MERCHANT_OPENIDS`（静态白名单）；
2. `merchant_admins` 集合中 `_id = "merchant_admins"` 文档的 `openids` 数组。

`ALLOW_AUTO_BOOTSTRAP` 已固定为 `false`：**不会**再把第一个打开小程序的人自动设为商家。

## 3. 目录结构

```
.
├── project.config.json          # appid: wxa1c01ec63c3d4e59
├── miniprogram/
│   ├── app.js / app.json / app.wxss / sitemap.json
│   ├── components/
│   │   ├── spec-picker/         # 规格选择弹层（数量加减、规格加价）
│   │   ├── pay-panel/           # 按 payMode 分流渲染的支付面板
│   │   └── merchant-exit/       # 商家端顶部「查看顾客端 →」（带 from=merchant）
│   ├── pages/
│   │   ├── entry/               # 启动身份识别与分流
│   │   ├── menu/                # 今日菜单（顾客首页，可转发）
│   │   ├── cart/                # 购物车 + 结算
│   │   ├── orders/              # 我的订单 + 再来一单
│   │   ├── order-detail/        # 订单详情（状态时间线/支付/商家动作）
│   │   ├── diagnose/            # 环境自检（openid / 是否商家 / 连通性 / 集合文档数）
│   │   └── merchant/
│   │       ├── index/           # 商家中心（权限校验 + 入口）
│   │       ├── menu/            # 菜单管理（发布/历史复制/菜品库）
│   │       ├── dish/            # 菜品新增/编辑（规格组、图片）
│   │       ├── board/           # 订单看板（确认收款/接单/出餐/完成）
│   │       ├── packing/         # 打包清单
│   │       ├── stats/           # 当日收益
│   │       └── settings/        # 收款设置（payMode / 二维码 / 文案）
│   └── utils/
│       ├── data-source.js       # 唯一数据入口：cloud / local 分流
│       ├── role-router.js       # 启动分流纯逻辑（可单测）
│       ├── merchant-guard.js    # 商家页角色守卫（非商家 reLaunch 回菜单）
│       ├── safe.js              # 展示层兜底 safeText / safeNumber / safeInt / safeArray
│       ├── menu-cache.js        # 菜单快照缓存失效钩子
│       ├── local-backend.js     # 本地演示后端（纯 JS，可单测）
│       ├── local-store.js       # wx storage 适配
│       ├── core/                # 与云函数共享的纯逻辑（金额/定价/状态机/时段/打包/统计）
│       └── api.js / money.js / cart.js / payment.js / status.js / image.js
├── cloudfunctions/
│   ├── api/                     # 唯一数据库入口，action 路由（含 health / whoami）
│   ├── pay/                     # mock / jsapi 支付
│   ├── paynotify/               # 微信支付结果回调
│   └── init/                    # 建集合 + 种子菜品
├── tests/
│   ├── run-tests.js             # 离线纯逻辑单测
│   └── static-check.js          # JS/JSON/页面/集合/浮点静态校验
├── README.md
└── ACCEPTANCE.md                # 一键照做的验收清单
```

## 4. 环境准备（按顺序做）

1. **确认 AppID**：`project.config.json` 已是 `wxa1c01ec63c3d4e59`。游客 AppID 无法使用云开发。
2. **导入工程**：微信开发者工具 → 导入项目 → 选择本目录（不要只选 `miniprogram`）。
3. **开通云开发**：工具栏「云开发」→ 开通。环境 ID 应为 `ordering-d0gyct6z1ff2afebd`（已写入 `miniprogram/app.js` 的 `CLOUD_ENV`）。若换环境，只改这一处。
4. **部署云函数**（右键每个目录 → 上传并部署：云端安装依赖）：
   - 顺序：`api` → `pay` → `paynotify` → `init`
   - 4 个目录都带 `package.json`（`wx-server-sdk`），不需要本地 npm 构建。
5. **初始化数据**：云开发控制台 → 云函数 → `init` → 云端测试，入参 `{"action":"setup"}`。它会创建 8 个集合、写入默认支付配置与示例菜品（幂等，可重复执行）。
6. **配置商家**：见第 5 节。配置完成并重新部署 `api` 后，重新编译小程序，`whoami` 会把你识别为商家并直接进看板。
7. **打开自检页**（`pages/diagnose`）：逐项确认「wx.cloud / CLOUD_ENV / 云函数连通性 / 8 个集合文档数 / 今日菜单 / 收款方式」全部通过。

## 5. 如何把你或店员设为商家

1. 打开小程序 → 进入任一页面底部的「自检」（或商家看板点「环境自检」）。
2. 自检页顶部「我的 openid」一栏点 **复制**（错误信息、整份自检报告也都支持复制）。
3. 二选一（两者都支持，静态白名单优先）：
   - **动态白名单（推荐）**：云开发控制台 → 数据库 → `merchant_admins` → 文档 `_id = "merchant_admins"` → 把 openid 追加到 `openids` 数组。集合不存在时先执行 `init` 的 `{"action":"setup"}`。
   - **静态白名单**：把 openid 填进 `cloudfunctions/api/config.js` 的 `MERCHANT_OPENIDS`（数组），重新部署 `api`。
4. 重新编译小程序 → 自动进入商家订单看板。店员同理（同一份 openids 数组可放多个 openid）。
5. 老板自己也要点单：商家看板顶部点「← 切换到顾客端」。

**一次性自助开通**（仅首次、仅空集合时可用）：`API` 侧保留 `ALLOW_SELF_CLAIM`，自检页在「集合为空 + 你不是商家」时会显示「将我的 openid 加为商家（仅空集合时一次性生效）」按钮。点击后把你的 openid 写入 `merchant_admins`。**上线前请把 `cloudfunctions/api/config.js` 的 `ALLOW_SELF_CLAIM` 改为 `false` 并重新部署。**

## 6. 集合与字段（数据字典）

金额字段一律为**整数分**（`priceCents` / `totalCents` / `amountCents`），展示时才格式化为元。

### dishes（菜品）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | 菜品 ID |
| `merchantId` | string | 商户 ID（当前固定 `merchant_001`，为多店预留） |
| `name` / `category` | string | 名称 / 分类 |
| `priceCents` | int | 基础价（分） |
| `imageUrl` | string | 云存储 fileID 或图片 URL，可空 |
| `specs` | array | `[{id,name,required,options:[{id,label,priceDeltaCents}]}]`，可空；加价为整数分 |
| `sortOrder` | int | 排序，小在前 |
| `onSale` / `soldOut` | bool | 是否上架 / 是否售罄 |
| `createdAt` / `updatedAt` | date | 时间戳 |

### menus（每日菜单）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` / `menuId` | string | `m_YYYYMMDD` |
| `merchantId` / `date` | string | 商户 / `YYYY-MM-DD`（Asia/Shanghai） |
| `title` | string | 菜单标题 |
| `dishIds` | array | 当日菜品 ID 列表 |
| `slots` | array | `[{id:"s1", label:"11:30-12:00", limit:20}]` |
| `published` | bool | 是否已发布 |
| `publishedBy` | string | 发布人 openid |
| `createdAt` / `updatedAt` | date | 时间戳 |

### orders（订单）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` / `orderNo` | string | 订单号 `YYYYMMDD-0001`，`_id` 与 `orderNo` 相同，天然防重 |
| `merchantId` / `date` / `menuId` | string | 商户 / 自然日 / 所属菜单 |
| `buyerOpenid` | string | 下单人 |
| `items` | array | 菜品快照：`dishId,name,category,unitPriceCents,specDeltaCents,specText,specOptionIds,qty,lineTotalCents,imageUrl` |
| `totalCents` / `totalQty` | int | 合计金额（分）/ 总份数（服务端重算结果） |
| `status` | string | 见第 7 节状态机 |
| `payChannel` | string | `transfer` / `jsapi` / `mock` |
| `transactionId` | string | 模拟/微信交易号，转账确认后为 `TRANSFER-<orderNo>` |
| `paidAt` / `transferredAt` / `confirmedAt` | date/null | 支付/转账/确认收款时间 |
| `transferNote` | string | 顾客转账备注 |
| `confirmedBy` | string | 确认收款的商家 openid |
| `pickupSlot` | object | `{id,label}` 取餐时段快照 |
| `remark` | string | 顾客备注（最长 60 字） |
| `packed` / `packedAt` | bool/date | 打包勾选 |
| `canceledAt` / `canceledBy` / `refunded` / `refundedCents` | date/string/bool/int | 取消与退款口径 |
| `statusHistory` | array | `[{status,at,by}]` 状态流水 |
| `createdAt` / `updatedAt` | date | 时间戳 |

### slot_counters（时段名额计数）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | `<menuId>__<slotId>` |
| `menuId` / `slotId` / `label` / `date` | string | 归属 |
| `limit` / `used` | int | 限量 / 已占用（`used < limit` 时条件自增，并发不超卖） |
| `createdAt` / `updatedAt` | date | 时间戳 |

### counters（订单号计数器）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | `seq_YYYYMMDD` |
| `date` / `seq` | string/int | 日期 / 当日序号（事务自增，失败回落原子 inc） |
| `updatedAt` | date | 时间戳 |

### merchant_admins（商家白名单）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | 固定 `merchant_admins` |
| `openids` | array | 商家 openid 列表（可放多人） |
| `createdAt` / `updatedAt` | date | 时间戳 |

### settings（云端配置）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | 固定 `payment` |
| `payMode` | string | `transfer`（默认）/ `jsapi` / `mock` |
| `transfer.qrImageUrl` | string | 收款二维码图片（云存储 fileID） |
| `transfer.payeeName` | string | 收款人展示 |
| `transfer.tipText` | string | 转账提示文案 |
| `updatedAt` / `updatedBy` | date/string | 修改时间 / 操作人 |

### payment_records（收款记录，用于对账）
| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `_id` | string | `pr_<orderId>`，同一订单只能确认一次 |
| `orderId` / `orderNo` / `merchantId` / `date` | string | 归属 |
| `amountCents` | int | 收款金额（分） |
| `channel` | string | `transfer` / `jsapi` |
| `operatorOpenid` | string | 确认收款的操作人 |
| `at` / `createdAt` | date | 确认时间 |
| `note` | string | 可选备注 |

### 建议索引（云开发控制台 → 数据库 → 索引管理）

| 集合 | 索引字段 |
| --- | --- |
| `orders` | `merchantId` + `date` + `createdAt`（降序）；`merchantId` + `buyerOpenid` + `createdAt`（降序）；`merchantId` + `date` + `status` |
| `dishes` | `merchantId` + `sortOrder` |
| `menus` | `merchantId` + `date`（降序） |
| `payment_records` | `merchantId` + `date` + `at`（降序） |
| `slot_counters` | 无需额外索引（按 `_id` 读写） |

> 云开发控制台默认集合权限选「仅管理端可读写」即可：所有读写都经云函数完成，前端不直连数据库。

## 7. 订单状态机

```
                     ┌─ 顾客点「我已转账」─> pending_confirm ─ 商家「确认已收款」─┐
pending_pay ─────────┤   （transfer 模式）                                ├─> paid
                     └─ mock / jsapi 支付成功 ──────────────────────────────┘
                                                                              │
                                                        paid ──接单──> accepted ──出餐──> ready ──完成──> completed
                                                                              │
pending_pay / pending_confirm / paid / accepted / ready ──取消──> canceled（终态）
```

- 仅 `paid` 可接单：`pending_confirm`（顾客自称已转账）**不能**进入制作。
- 非法流转由 `cloudfunctions/api/core/state.js` 拒绝（`ILLEGAL_TRANSITION`）。
- 已收款订单取消 → 记为退款口径（`refunded=true`、`refundedCents`），收益里单列「退款金额」。
- 收益口径：`paidCents` = `paid/accepted/ready/completed`；`pendingConfirmCents` 单独列出，确认收款后才进入已收款。

## 8. 支付方式（可配置）

配置唯一来源：`settings` 集合的 `payment` 文档（商家端「收款设置」页面可改），读取入口在 `cloudfunctions/api/lib/settings.js`：

| payMode | 行为 | 前端结算按钮 |
| --- | --- | --- |
| `transfer`（默认） | 下单后 `pending_pay`，展示收款码/收款人/文案；顾客点「我已转账」→ `pending_confirm`；商家「确认已收款」→ `paid`，并写 `payment_records` | 提交订单，稍后转账 |
| `jsapi` | 下单后调 `cloudPay.unifiedOrder`，前端 `wx.requestPayment`；回调由 `paynotify` 置 `paid`。**未配置商户号时明确报错、不白屏**（结算按钮置灰并展示原因） | 提交订单并支付 |
| `mock` | 仅开发调试：订单页点「模拟支付」后云函数置 `paid` 并写 `MOCK` 交易号 | 提交订单（模拟支付） |

前端分流只在一个组件/工具里：`components/pay-panel` + `utils/payment.js`，页面不写两套结算流程。local 模式复用同一套 `core/paymode` 逻辑。

### 切到真实微信支付（jsapi）步骤

1. 微信支付商户平台开通 JSAPI 支付，取得**商户号（mchid / subMchId）**；按云开发 cloudPay 文档配置证书/密钥。
2. 云开发控制台 → 设置 → 微信支付配置：绑定商户号，开通 `cloudPay`。
3. 修改 `cloudfunctions/pay/config.js` 的 `WXPAY` 段，并同步修改 `cloudfunctions/api/config.js` 的 `WXPAY` 段（两处必须一致）：
   ```js
   WXPAY: {
     ENABLED: true,
     SUB_MCH_ID: '你的商户号',
     ENV_ID: 'ordering-d0gyct6z1ff2afebd',
     BODY_PREFIX: '点餐'
   }
   ```
   重新部署 `pay` 与 `api` 云函数（`paynotify` 无需改配置）。
4. 商家端「收款设置」切到「小程序内微信支付」并保存。
5. 验证：下单 → 调起支付 → `paynotify` 回调把订单置为 `paid`（金额会按整数分比对，不一致拒绝）。
- 代码里**没有写死任何密钥/商户号**；`pay` 与 `paynotify` 只读配置与环境变量。

## 9. 云函数接口（前端唯一调用面）

云函数 `api` 入参 `{ action, payload }`，返回 `{ code, data }`；`code !== 0` 时 `message` 可直接展示。

- 诊断：`health`（环境 ID、服务器时间、集合文档数、今日菜单、收款方式、身份）、`whoami`（openid + isMerchant）
- 顾客：`menu.today`、`settings.payment`、`order.create`、`order.list`、`order.detail`、`order.markTransferred`、`order.cancel`、`order.reorder`
- 商家：`merchant.checkAccess`、`merchant.claimSelf`（一次性自助，空集合 + 手动确认）、`merchant.listDishes`、`merchant.saveDish`、`merchant.toggleDish`、`merchant.deleteDish`、`merchant.publishMenu`、`merchant.copyMenu`、`merchant.menuHistory`、`merchant.menuDetail`、`merchant.orders`、`merchant.transition`（accept/ready/complete/cancel）、`merchant.confirmReceipt`、`merchant.packing`、`merchant.setPacked`、`merchant.stats`、`merchant.getPaymentSettings`、`merchant.savePaymentSettings`

下单云函数做了：服务端价格重算（忽略前端金额）、菜单/上架/售罄校验、规格校验、时段名额条件原子自增（`SLOT_FULL` 回滚）、`YYYYMMDD-0001` 订单号（事务计数器 + `_id=orderNo` 防重）。

## 10. 环境自检页（`pages/diagnose`）

入口：顾客端底部「自检」、商家看板「环境自检」、首页错误态「打开自检」。逐项显示「通过 / 失败 / 注意 + 现象 + 修复动作」，支持复制整份报告与 openid。

| 检查项 | 说明 | 失败时的修复动作 |
| --- | --- | --- |
| 数据模式 | 当前是 cloud 还是 local | 点「切换到云端模式 / 本地演示模式」 |
| `wx.cloud` | 基础库是否支持云开发 | 调试基础库调到 2.2.3 以上、使用小程序模式 |
| `CLOUD_ENV` | 是否为空/占位，当前值 | 改 `miniprogram/app.js` 的 `CLOUD_ENV` |
| 我的 openid | 未获取到时也给出原因 | 复制后加入白名单 |
| 是否商家 | 白名单命中结果 | 加入 `merchant_admins.openids` / `MERCHANT_OPENIDS` |
| 云函数 api 可达性 | 调 `health` 的真实结果（errorCode + errMsg） | 右键 `cloudfunctions/api` 上传并部署 |
| 8 个集合文档数 | menus / orders / dishes / settings / merchant_admins / payment_records / slot_counters / counters | 执行 `init` 的 `{"action":"setup"}` 或手动建集合 |
| 今日菜单 | 是否已发布、菜品数 | 商家端菜单管理 → 发布今日菜单 |
| 收款方式 | `payMode` 是否可用 | 切回 `transfer` 或配置 cloudPay |

## 11. 排障：导入后是空页面 / 没有商家入口

按现象排查：

1. **首页显示「云端未连通」/「订单加载失败 → CALL_FAILED」**
   → 打开「自检」：多半是 `api` 云函数未部署、`CLOUD_ENV` 不对，或云开发未开通。
   → 修复顺序：确认环境 ID → 部署 `api`（云端安装依赖）→ 执行 `init` 的 `{"action":"setup"}` → 重新自检。
   → 弹窗会明确显示「云端不可用：<errorCode> <errMsg>」，并提供「重试」与「用本地演示」两个按钮；**只有主动点「用本地演示」才会切 local**，不会再静默回退。
2. **首页显示「商家尚未发布今日菜单」但没有商家入口**
   → 这是正常的：顾客端不显示商家入口，身份由启动时的 `whoami` 决定。
   → 你还没被设为商家：进「自检」→ 复制 openid → 加入白名单（第 5 节）→ 重新编译。
   → 已加入但仍不生效：确认 `merchant_admins` 文档 `_id` 是 `merchant_admins`、字段名是 `openids` 数组；或改静态白名单后重新部署 `api`。
3. **顶部出现「身份校验失败，点此自检」**
   → `whoami` 调不通（云端不可达）。按第 1 条修复云端，或先用本地演示模式。
4. **商家看板提示「无商家权限」并显示 openid**
   → 复制该 openid 加入白名单；或确认当前 openid 与配置的一致（同一个微信号、同一环境）。
   → 所有商家页在进入时都会再校验一次；即使直接改页面路径也会被 `wx.reLaunch` 打回菜单并提示「无商家权限」。
5. **自检页集合显示「不存在」**
   → 执行 `init` 云函数 `{"action":"setup"}`；集合权限选「仅管理端可读写」。
6. **收不到菜单但集合有数据**
   → 确认今日菜单的 `published` 为 `true`，且 `date` 是 Asia/Shanghai 当天。
7. **弹窗出现 `UNKNOWN: {} is not a function`**
   → 这是 JS 自动分号插入（ASI）把「对象字面量 + 下一行以 `(` 开头」解析成了「调用对象」；已在 `order-detail.js` 的 `;(order.actions || []).forEach(...)` 修复，并给 `tests/static-check.js` 增加了同类隐患扫描。若你自己改代码后复现，检查是否漏了行首分号。
8. **时段显示「剩undefined」**
   → 旧菜单的 `slots` 可能是字符串或缺少 `limit`。`core/slots.js` 的 `readSlots` 与 `slotAvailability` 已兼容并给默认限量 20；页面再经 `safeText/safeNumber` 兜底，不会再有 undefined 上屏。
9. **商家新增菜品后顾客端看不到**
   → 「菜品库」不等于「今日菜单」：新增菜只在菜品库；到「菜单管理」点该菜的「加入今日菜单」，或重新「发布今日菜单」。保存/发布后顾客端下拉刷新即可见。

## 12. 本地演示模式（免云开发）

用途：不开通云开发 / 云函数未部署时，也能完整跑通流程，用于演示与自测。

- 切换：自检页点「用本地演示模式（数据不写云端）」并确认；本机覆盖值保存在 storage（key `ordering_data_mode_v1`）。默认模式仍是 `cloud`（`miniprogram/app.js` 的 `DATA_MODE`）。
- **不静默回退**：云端失败时先弹窗「云端不可用：<errorCode> <errMsg>」，由你选择「重试」或「用本地演示」；未点击前模式保持不变。
- **常驻横幅**：local 模式下顾客端顶部有不可关闭的橙色横幅「本地演示模式：数据不会同步到云端，其他人看不到」，右侧可一键「切回云端」。
- 首次启动自动写入种子：4 个分类共 8 个菜（含 1 个规格菜「黄焖鸡」、1 个售罄菜「凉拌黄瓜」）、1 个取餐时段（11:30-12:00，限量 20）、默认收款方式 `transfer`、一份已发布的今日菜单。
- 完整路径：发布菜单 → 点餐 → 结算 → 转账 →「我已转账」→ 商家确认收款 → 接单 → 出餐 → 打包清单 → 当日收益。
- 商家与顾客读同一个本地 store（key `ordering_local_db_v1`）：商家加菜/发布后，切到顾客端（商家端「查看顾客端 →」）刷新即可见。
- 数据隔离：local 数据只存 `wx.setStorageSync('ordering_local_db_v1')`，**不会写入云端**；云端数据也不会读入 local。两套数据互不影响。
- 切回云端：自检页点「切回云端模式（清空本地演示数据）」；会清除本地商家角色标记、演示数据与菜单快照缓存，再重新 `wx.cloud.init` 并重启到首页。
- 上线前必须关闭 local：把 `miniprogram/app.js` 的 `DATA_MODE` 保持 `'cloud'`，并确认发布版本里没有用户切换成本地模式（如需彻底移除，可隐藏自检页的切换按钮）。

## 13. 本地验证（不依赖云环境）

```bash
node tests/run-tests.js     # 纯逻辑单测（金额/定价/时段/状态机/打包/收益/支付/角色分流/local 数据源）
node tests/static-check.js  # JS/JSON/页面/集合/浮点静态校验
```

覆盖：金额整数分与字符串解析、价格重算（忽略前端金额/售罄/下架/菜单范围/规格必选/合并/限量）、时段标准化与容量、状态机合法与非法流转、transfer→pending_confirm→paid、未确认收款不能接单、打包聚合、收益已收款/待确认/退款口径、确认收款后进入已收款、jsapi 未配置报错分支、上海自然日换算、启动身份分流（商家/顾客/失败三分支）、local 数据源（种子、下单重算、限量、转账闭环、打包、收益）、展示层兜底（safeText/safeNumber 对 undefined/null/NaN）、旧数据字符串时段、商家权限守卫（decideAccess + 非商家 reLaunch）、菜单缓存失效、商家加菜→顾客端同源可见、云端失败不自动切 local。

## 14. 已知限制

- **未在微信开发者工具中实机运行**；页面渲染、转发卡片、图片上传、真实支付需自行验证。
- 单商户实现；`merchantId` 字段已预留，但多店/多租户未实现。
- `jsapi` 退款未接入（退款只在订单上记录「退款口径」）；真实退款需在商户平台操作。
- 群分享卡片在开发版/体验版受微信限制，正式发布后生效；菜单无图片时用默认文案。
- 菜品「售罄」是手动开关，没有按库存自动扣减；时段限量只限订单数，不限菜品份数。
- 订单号序号为 4 位，单日超过 9999 单会变长（仍唯一）。
- 打包清单只取当日「已收款且未完成」订单；已完成订单不再出现在清单里。
- 一次性自助成为商家（`merchant.claimSelf`）仅用于首次配置：上线前把 `ALLOW_SELF_CLAIM` 改为 `false` 并重新部署 `api`。
- local 演示模式的数据仅存本机，换设备/清缓存会重置；不能替代云端验证。

## 15. 验收

按 [ACCEPTANCE.md](./ACCEPTANCE.md) 从「身份分流」点一遍到「看收益」。
