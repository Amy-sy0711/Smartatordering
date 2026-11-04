# Smartatordering
智在点餐

用小程序的「今日菜单 + 在线点单 + 收款确认 + 打包清单 + 当日收益」替代群接龙：顾客自己选菜下单，商家按下单顺序接单出餐，收款与对账有记录可查。支付方式可在云端配置为 **转账收款（默认）/ 微信支付 jsapi / 模拟支付 mock**。

## 0. 做到什么程度

- ✅ 完整工程已生成，可直接导入微信开发者工具（`project.config.json` 已配好 `miniprogramRoot` / `cloudfunctionRoot`）。
- ✅ 顾客端：今日菜单（分类分组、售罄置灰禁加购）、规格弹层、购物车结算（时段限量、备注、金额）、下单支付、订单详情、我的订单、再来一单、转发群卡片。
- ✅ 商家端：菜单管理与发布（从历史复制）、菜品增删改/上下架/售罄、订单看板（确认收款/接单/出餐/完成/取消）、打包清单（聚合 + 逐单勾选 + 复制文字）、当日收益（已收款/待确认/待付款/退款 + 销量排行 + 收款记录）、收款设置。
- ✅ 云函数：`api`（全部读写）、`pay`（mock/jsapi）、`paynotify`（支付回调）、`init`（建集合 + 种子数据 + 首个商家）。
- ✅ 离线单测与静态校验脚本已通过（见第 9 节）。
- ⚠️ **未在微信开发者工具中实机运行**（本机未安装开发者工具），以下必须由你自行验证：云函数部署、集合创建、真机/模拟器页面渲染、图片上传、转发卡片、真实微信支付调起。

**必须由你配置的项**：AppID、开通云开发环境、部署 4 个云函数并执行一次 `init`、商家 openid 白名单（或使用演示模式自助成为商家）。默认 `payMode=transfer`，不需要商户号即可完整跑通下单→转账→确认收款→打包→收益。

## 1. 目录结构

```
.
├── project.config.json          # appid 为占位 touristappid，需替换
├── miniprogram/
│   ├── app.js / app.json / app.wxss / sitemap.json
│   ├── components/
│   │   ├── spec-picker/         # 规格选择弹层（数量加减、规格加价）
│   │   └── pay-panel/           # 按 payMode 分流渲染的支付面板
│   ├── pages/
│   │   ├── menu/                # 今日菜单（顾客首页，可转发）
│   │   ├── cart/                # 购物车 + 结算
│   │   ├── orders/              # 我的订单 + 再来一单
│   │   ├── order-detail/        # 订单详情（状态时间线/支付/商家动作）
│   │   └── merchant/
│   │       ├── index/           # 商家中心（权限校验 + 入口）
│   │       ├── menu/            # 菜单管理（发布/历史复制/菜品库）
│   │       ├── dish/            # 菜品新增/编辑（规格组、图片）
│   │       ├── board/           # 订单看板（确认收款/接单/出餐/完成）
│   │       ├── packing/         # 打包清单
│   │       ├── stats/            # 当日收益
│   │       └── settings/        # 收款设置（payMode / 二维码 / 文案）
│   └── utils/                   # api / money / cart / payment / status / image
├── cloudfunctions/
│   ├── api/                     # 唯一数据库入口，action 路由
│   ├── pay/                     # mock / jsapi 支付
│   ├── paynotify/               # 微信支付结果回调
│   └── init/                    # 建集合 + 种子菜品（带 openid 调用时记录首个商家）
├── tests/
│   ├── run-tests.js             # 离线纯逻辑单测
│   └── static-check.js          # JS/JSON/页面/集合/浮点静态校验
├── README.md
└── ACCEPTANCE.md                # 一键照做的验收清单
```

## 2. 环境准备（按顺序做）

1. **替换 AppID**：打开 `project.config.json`，把 `"appid": "touristappid"` 换成你自己的小程序 AppID。游客 AppID 无法使用云开发。
2. **导入工程**：微信开发者工具 → 导入项目 → 选择本目录（不要只选 `miniprogram`）。
3. **开通云开发**：工具栏「云开发」→ 开通，记下环境 ID。若使用非默认环境，把环境 ID 填到 `miniprogram/app.js` 的 `CLOUD_ENV`；留空表示使用默认环境。
4. **部署云函数**（右键每个目录 → 上传并部署：云端安装依赖）：
   - 顺序：`api` → `pay` → `paynotify` → `init`
   - 4 个目录都带 `package.json`（`wx-server-sdk`），不需要本地 npm 构建。
5. **初始化数据**：云开发控制台 → 云函数 → `init` → 云端测试，入参 `{"action":"setup"}`。它会创建 8 个集合、写入默认支付配置与 5 个示例菜品（幂等，可重复执行）。
6. **商家白名单**（二选一）：
   - 静态白名单：把 openid 填进 `cloudfunctions/api/config.js` 的 `MERCHANT_OPENIDS`（数组），重新部署 `api`；
   - 动态白名单：在 `merchant_admins` 集合维护 `_id = "merchant_admins"` 的文档，字段 `openids: ["xxx"]`；
   - 演示模式：`ALLOW_AUTO_BOOTSTRAP` 默认为 `true`，当上述两处都为空时，第一个打开「商家入口」的人会自动成为商家（**上线前请关闭并固定 openid**）。
7. 在小程序里进入首页 → 底部「商家入口」→ 商家中心顶部会显示你的 openid，可复制后回填白名单。

## 3. 集合与字段（数据字典）

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
| `status` | string | 见第 4 节状态机 |
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
| `openids` | array | 商家 openid 列表 |
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

## 4. 订单状态机

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

## 5. 支付方式（可配置）

配置唯一来源：`settings` 集合的 `payment` 文档（商家端「收款设置」页面可改），读取入口在 `cloudfunctions/api/lib/settings.js`：

| payMode | 行为 | 前端结算按钮 |
| --- | --- | --- |
| `transfer`（默认） | 下单后 `pending_pay`，展示收款码/收款人/文案；顾客点「我已转账」→ `pending_confirm`；商家「确认已收款」→ `paid`，并写 `payment_records` | 提交订单，稍后转账 |
| `jsapi` | 下单后调 `cloudPay.unifiedOrder`，前端 `wx.requestPayment`；回调由 `paynotify` 置 `paid`。**未配置商户号时明确报错、不白屏**（结算按钮置灰并展示原因） | 提交订单并支付 |
| `mock` | 仅开发调试：订单页点「模拟支付」后云函数置 `paid` 并写 `MOCK` 交易号 | 提交订单（模拟支付） |

前端分流只在一个组件/工具里：`components/pay-panel` + `utils/payment.js`，页面不写两套结算流程。

### 切到真实微信支付（jsapi）步骤

1. 微信支付商户平台开通 JSAPI 支付，取得**商户号（mchid / subMchId）**；准备 API 证书/密钥（按云开发 cloudPay 文档配置）。
2. 云开发控制台 → 设置 → 微信支付配置：绑定商户号，开通 `cloudPay`。
3. 修改 `cloudfunctions/pay/config.js` 的 `WXPAY` 段，并同步修改 `cloudfunctions/api/config.js` 的 `WXPAY` 段（两处必须一致：前者真正发起支付，后者用于前端「是否可用」判断）：
   ```js
   WXPAY: {
     ENABLED: true,
     SUB_MCH_ID: '你的商户号',
     ENV_ID: '你的云开发环境 ID',
     BODY_PREFIX: '点餐'
   }
   ```
   重新部署 `pay` 与 `api` 云函数（`paynotify` 无需改配置）。
4. 商家端「收款设置」切到「小程序内微信支付」并保存。
5. 验证：下单 → 调起支付 → `paynotify` 回调把订单置为 `paid`（金额会按整数分比对，不一致拒绝）。
- 代码里**没有写死任何密钥/商户号**；`pay` 与 `paynotify` 只读配置与环境变量。

## 6. 云函数接口（前端唯一调用面）

云函数 `api` 入参 `{ action, payload }`，返回 `{ code, data }`；`code !== 0` 时 `message` 可直接展示。

- 顾客：`menu.today`、`settings.payment`、`order.create`、`order.list`、`order.detail`、`order.markTransferred`、`order.cancel`、`order.reorder`
- 商家：`merchant.checkAccess`、`listDishes`、`saveDish`、`toggleDish`、`deleteDish`、`publishMenu`、`copyMenu`、`menuHistory`、`menuDetail`、`orders`、`transition`（accept/ready/complete/cancel）、`confirmReceipt`、`packing`、`setPacked`、`stats`、`getPaymentSettings`、`savePaymentSettings`（前缀均为 `merchant.`）

下单云函数做了：服务端价格重算（忽略前端金额）、菜单/上架/售罄校验、规格校验、时段名额条件原子自增（`SLOT_FULL` 回滚）、`YYYYMMDD-0001` 订单号（事务计数器 + `_id=orderNo` 防重）。

## 7. 本地验证（不依赖云环境）

```bash
node tests/run-tests.js     # 纯逻辑单测
node tests/static-check.js  # JS/JSON/页面/集合/浮点静态校验
```

覆盖：金额整数分与字符串解析、价格重算（忽略前端金额/售罄/下架/菜单范围/规格必选/合并/限量）、时段标准化与容量、状态机合法与非法流转、transfer→pending_confirm→paid、未确认收款不能接单、打包聚合、收益已收款/待确认/退款口径、确认收款后进入已收款、jsapi 未配置报错分支、上海自然日换算。

## 8. 已知限制

- **未在微信开发者工具中实机运行**；页面渲染、转发卡片、图片上传、真实支付需自行验证。
- 单商户实现；`merchantId` 字段已预留，但多店/多租户未实现。
- `jsapi` 退款未接入（退款只在订单上记录「退款口径」）；真实退款需在商户平台操作。
- 群分享卡片在开发版/体验版受微信限制，正式发布后生效；菜单无图片时用默认文案。
- 菜品「售罄」是手动开关，没有按库存自动扣减；时段限量只限订单数，不限菜品份数。
- 订单号序号为 4 位，单日超过 9999 单会变长（仍唯一）。
- 打包清单只取当日「已收款且未完成」订单；已完成订单不再出现在清单里。
- 演示模式（白名单为空时首个进入者自动成为商家）仅便于本地跑通，上线前必须固定 openid 并关闭 `ALLOW_AUTO_BOOTSTRAP`。

## 9. 验收

按 [ACCEPTANCE.md](./ACCEPTANCE.md) 从「发布菜单」点一遍到「看收益」。
