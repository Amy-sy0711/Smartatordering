# 商家网页后台（merchant-console）

给商家自己使用：菜单/分类、订单看板、打包、营收、员工、导出 CSV。只能访问自己 `merchantId` 的数据。

## 部署

1. 把 `index.html / app.js / style.css` 上传到 CloudBase 静态托管，或发布到 GitHub Pages。
2. 云开发控制台 → 环境 → 安全配置 → **Web 安全域名**：加入实际访问域名。
3. 云函数环境变量：
   - `merchantAuth` / `api`：`MERCHANT_TOKEN_SECRET`（至少 16 位随机串；未设置时回退使用 `ADMIN_TOKEN_SECRET`）
4. 部署 `merchantAuth` 与 `api` 云函数。
5. 平台管理台创建商家后，把一次性初始密码交给商家；商家在页面填环境 ID + 账号 + 密码登录。

> 页面通过 CloudBase JS SDK 匿名登录后调用云函数；商家 token 存 `sessionStorage`，退出即清。需在控制台开启匿名登录。

## 登录

- 账号：商家 `loginUsername`（默认等于 `merchantId`）
- 密码：平台创建商家时生成的一次性初始密码（服务端只存 scrypt 哈希）
- 商家被 `disabled` 或 token 被吊销时无法登录/调用，提示联系平台管理员

## 功能

- 菜单：菜品库增删改、上下架/售罄、从历史复制、今日菜单勾选发布（标题 + 取餐时段）
- 分类：新增/重命名/删除/上移下移/启用停用；顾客端按 `sort` 排序，禁用分类不展示
- 订单看板：确认收款、出餐（生成取餐码）、已取餐、取消
- 打包：按取餐时段聚合 + 逐单勾选
- 营收：当日汇总 + 销量排行
- 员工：绑定/解绑 openid
- 导出 CSV：只导出本租户订单；导出动作写审计（只记条数）

## 数据隔离

所有请求都带商家 token；服务端从 token 取 `merchantId` 并强制过滤，前端传入的 `merchantId` 一律忽略。跨租户读写会返回 `FORBIDDEN` / `MERCHANT_NOT_FOUND`。

## 注意

- 「菜品库」与「今日已发布菜单」是两件事：只在菜品库新增、没有勾选进今日菜单的菜，顾客端不会显示。发布后再让顾客刷新。
- 修改菜单后系统会更新 `menuVersion/updatedAt` 并使客户端菜单缓存失效。
