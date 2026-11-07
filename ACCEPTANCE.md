# 验收清单（照做一遍）

> 前提：已确认 AppID（`wxa1c01ec63c3d4e59`）、云开发环境 `ordering-d0gyct6z1ff2afebd`，部署 `api / pay / paynotify / init / adminAuth / adminApi / merchantAuth`，配置环境变量 `ADMIN_TOKEN_SECRET`、`MERCHANT_TOKEN_SECRET`、`ADMIN_BOOTSTRAP_PASSWORD`，并执行过一次 `init` 的 `{"action":"setup"}`。
> 默认 `payMode=transfer`。所有步骤均需你在本地开发者工具/浏览器中实际执行；本项目未声称已实机运行。

## A. 初始化与账号

1. 执行 `init {"action":"setup"}` → 返回 `merchant`、`migrated`、`categories` 等计数；`merchants` 出现 `merchant_001`。
2. 打开 `admin-console/`，填环境 ID，用 `ADMIN_BOOTSTRAP_PASSWORD` 首次登录 → 自动创建第一个管理员；再次用同一 bootstrap 口令登录应失败（已失效）。
3. 管理台新建商家 → 返回 `merchantId` 与一次性初始密码；商家用该账号在 `merchant-console/` 登录成功。
4. 管理台把某个 openid 绑定为 `owner`（或 `staff`）→ 小程序重新编译后该 openid 进入商家看板。

## B. 三层后台边界（重点验收）

1. 以平台管理员登录 `admin-console/`：页面没有「订单明细 / 菜品明细 / 营收明细 / 顾客信息」入口。
2. 直接在浏览器控制台尝试调用 `adminApi` 的 `merchant.orders`、`order.list`、`order.detail`、`dish.list`、`menu.detail`、`merchant.stats`、`merchant.exportOrders` → 均应返回错误（action 不在白名单），且不返回任何业务数据。
3. 检查 `cloudfunctions/adminApi/index.js`：不存在 `listOrders / getOrderDetail / listDishes` 等业务读取 action；健康面板只展示计数、状态、错误码分布。
4. 管理台执行任一写操作（新建商家/启停/绑定员工）→ `audit_logs` 新增记录，包含操作者、action、`merchantId`、结果、时间，且不含订单/菜品/顾客字段值。
5. 以商家 A 登录 `merchant-console/`：只能看到 A 的菜单、分类、订单、营收、员工；用浏览器改请求体里的 `merchantId` 为 B，返回数据仍为 A（服务端只认 token）。
6. 以商家 A 导出 CSV → 文件只含 A 的订单；`audit_logs` 增加一条导出记录（只记条数）。
7. 小程序商家端：A 的店员只能接单/出餐/打包/看统计，尝试发布菜单或改收款设置应被拒绝（`ROLE_FORBIDDEN`）。

## C. 入口与角色分流

1. 分享卡片路径带 `mid=<merchantId>` → 顾客进入后菜单标题为对应商家，下单落到该商家。
2. 无 `mid` → 使用 `DEFAULT_MERCHANT_ID`（`merchant_001`）。
3. 顾客端页面底部/顶部没有任何进入商家端的按钮、图标或隐藏跳转。
4. 顾客直接跳 `/pages/merchant/index/index` 或其他商家页 → 被 `wx.reLaunch` 回菜单并 toast「无商家权限」。
5. 平台管理员账号进入小程序 → 进顾客端菜单（不进商家端；`api` 对 admin 只放行 `whoami / health`）。
6. 商家 `disabled` 时：顾客下单返回 `MERCHANT_DISABLED`；商家写操作返回 `MERCHANT_DISABLED`；管理台恢复 `active` 后正常。

## D. 商家：菜单 / 分类 / 发布

1. 商家后台新建菜品 → 出现在「菜品库」；「今日已发布菜单」不含它，顾客端也看不到（这是预期，不是 bug）。
2. 勾选该菜品并「发布今日菜单」→ 提示「已发布，顾客端刷新即可见」；顾客端下拉刷新后可见。
3. 菜单发布/编辑后，云端 `todayMenu` 的 `menuVersion / updatedAt` 更新；客户端菜单快照缓存失效。
4. 分类管理：新增/重命名/上移下移/启用停用/删除；顾客端按 `sort` 升序渲染，禁用分类不显示，空分类不出现标题。
5. 重命名分类后，该分类下菜品同步改到新分类名。
6. 空分类（无菜品）不应在顾客端渲染出空标题。
7. 顾客端左侧分类栏：分类数 ≥ 2 时显示（0/1 个不显示左栏）；点击分类右侧列表平滑滚动到该分类标题，高亮立即生效（背景 + 左侧橙色条 + 加粗）。
8. 右侧列表滚动时反向高亮当前分类：`bindscroll` 每 100ms 比对一次；点击跳转后的动画期间暂停反向同步，避免高亮跳回；停在分类标题边界不抖动；滚到底部停在最后一个分类。
9. 分类为空不渲染标题与左栏；下拉刷新/切换数据源后重新测量标题位置；菜品图加载完成后重算一次偏移，避免图片撑开导致错位。
10. 点击菜品图调用 `wx.previewImage` 看大图：`urls` 只含当前菜品图、`current` 指向被点项；无图或图片加载失败不弹预览，只给轻提示；图片为空时仍显示原占位样式。
11. 加购、规格弹窗、售罄置灰、时段 `leftText`、下拉刷新、身份分流与「平台管理」入口均不受左栏改动影响；购物车/订单详情中出现的菜品缩略图（有图时）同样可点开预览。

## E. 顾客：点餐与支付

1. 选菜 → 规格弹层（必选规格未选应拒绝）→ 购物车 → 选时段 → 备注 → 提交。
2. 金额以服务端重算为准；前端金额被忽略。
3. 时段满档置灰；直接调接口应返回 `SLOT_FULL`。
4. transfer：订单详情「我已转账」→ 商家「确认已收款」→ 变「待接单」，写 `payment_records`。
5. mock：切 mock 后「模拟支付」→ 直接「待接单」。
6. jsapi 未配置商户号：结算按钮禁用并说明原因，不白屏。

## F. 商家：接单 / 打包 / 营收

1. 看板：待确认收款不能接单；待接单 → 接单 → 出餐 → 完成，非法流转返回 `ILLEGAL_TRANSITION`。
2. 打包清单：汇总已收款未完成订单，按菜品+规格聚合；逐单勾选后刷新保留。
3. 营收：已收款 = paid/accepted/ready/completed；待确认单列；取消已收款订单进入退款口径。
4. 切换日期按 Asia/Shanghai 自然日。

## G. 员工绑定与解绑

1. 管理台/商家后台输入 openid 绑定员工 → 该 openid 重新编译后进入对应商家看板。
2. 解绑后该 openid 进商家页被拦回菜单。
3. 绑定已属于其他商家的 openid → 应拒绝（本期不支持一人多店）。
4. 不能把自己（当前 token 对应的商家账号）绑成员工。

## H. 本地演示模式（仅开发调试）

1. 云端失败时**不会**自动切 local：弹窗只给「重试 / 关闭」，并显示「云端不可用：<code> <message>」。
2. 只有把 `miniprogram/app.js` 的 `DATA_MODE` 改为 `'local'`（或写入 storage）才进入 local；页面顶部出现不可关闭橙色横幅「本地演示模式：数据不会同步到云端，其他人看不到」。
3. local 下商家端与顾客端读写同一个本地 store（同一 key、同一版本）：加菜 → 切顾客端 → 可见。
4. 商家端没有 local/云端切换入口；`pages/diagnose` 仅平台管理员可进。
5. local 下模拟下单 → 切回 cloud → 云端订单列表不出现该单。

## I. 环境自检（仅平台管理员）

1. 用平台管理员（`admins` 中绑定 openid）打开 `pages/diagnose` → 可查看自检。
2. 商家/顾客打开 `pages/diagnose` 或直接路径跳入 → 被拦回菜单并 toast「仅平台管理员可使用」。
3. 商家端页面不再有「环境自检」入口；云端异常只提示「系统暂时不可用，请联系管理员」+ 重试，不暴露环境 ID、错误码、集合名。
4. 管理台「系统健康」可看到：云函数可达性、集合存在性与文档数、默认商家状态、支付模式、今日菜单是否发布、最近 24h 错误码分布。

## J. 本轮 bug 回归

1. **崩溃**：订单详情两条路径不再出现 `{} is not a function`；菜单、订单、收益往返无崩溃。
2. **undefined**：任何页面不出现 `undefined` / `null` / `NaN`；时段显示「剩 N」或「已满」。
3. **加菜可见**：商家后台「菜品库」与「今日已发布菜单」分开；发布后顾客下拉刷新可见。
4. **云端失败**：不自动切 local；显式提示并提供重试/关闭。
5. **权限**：顾客端无商家入口；商家页直达被拦。
6. **商家预览**：商家看板「查看顾客端」带 `from=merchant`，顶部「商家预览中」，可一键返回看板。

## 离线校验（无需开发者工具）

```bash
node tests/run-tests.js
node tests/static-check.js
```

两项均应输出全部通过。静态检查覆盖：JS 语法、JSON、页面/组件、集合一致性、金额无浮点、ASI 隐患、模板高风险表达式提示、商家页守卫、`adminApi/admin-console` 无业务读取、商家后台不混用管理员 token、业务查询含 `merchantId`、`pages/diagnose` 仅管理员。
