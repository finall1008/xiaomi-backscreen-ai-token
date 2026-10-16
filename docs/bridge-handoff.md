# 桥侧对接：网页登录与后台刷新

模块接入桥的模块网页登录、统一 JobScheduler 后台调度与统一周期设置，使用 API v2。

## 当前模块布局

模块 id 为 `dev.finall.aitoken`，`version` 为 `0.3.0`，`versionCode` 为 `6`，声明 `network` / `storage`。Git 导入读取仓库根目录，手机不执行 npm：

- [module.json](<../module.json>)
- `card/`：编译后的经典卡片 JS（async/await 已转为生成器）与静态 assets
- `webroot/`：已构建的静态设置页
- `background/main.js`：自包含后台入口，保持 WebView 原生 async/await

源码在 `src/` 与 [prototype/main.js](<../prototype/main.js>)。`npm run build` 生成上述根目录产物；这三份产物必须提交，导入 `https://github.com/finall1008/xiaomi-backscreen-ai-token` 的 `main` 分支才与当前模块一致。Release ZIP 是同一套根目录内容的另一安装方式。

运行时约定：

- 背屏用 `bridge.net.request`；设置页的 MiMo / Cursor 请求也走原生桥，Codex / Kimi / DeepSeek 保持 WebView fetch。
- 背屏与预览只展示 `display.providers` 勾选的最多四个已配置来源；无偏好时默认前四个已配置来源。隐藏不清除凭据，不影响设置页及后台取数。
- MiMo 所有请求显式传入 `cookies`：网页登录、会话查询 / 恢复用 `true`；获取新的签名登录入口、兼容旧手动 Cookie 用 `false`。设置页以是否存在此选项区分原生与 fetch。
- 核心以 `AiUsageCore.create({storage, request, allowTokenRefresh})` 注入存储和网络。
- 背屏与后台设 `allowTokenRefresh:false`，避免与设置页同时轮换 Codex refresh token；设置页是唯一续期方。
- `background.intervalMinutes:30` 只声明默认周期；用户在桥内统一覆盖该模块周期，最短 5 分钟，更新模块保留覆盖值。模块不读取独立周期配置，不设前台定时器。
- `bridge.card.requestRefresh()` 通知背屏重读用量缓存，不触发网络；背屏首页下拉查询全部已配置来源，详情页顶部下拉只查询当前来源，不受缓存年龄限制。

## 当前 storage 键

每个来源使用独立键，不保存整份包含所有凭据的状态对象。

| 键 | 内容 |
| --- | --- |
| `auth.codex` | `{accessToken, refreshToken, idToken, accountId}` |
| `auth.kimi` / `auth.deepseek` | API Key 字符串 |
| `auth.mimo` | `{type:'webview'}`：已检查的模块 Profile 会话；兼容旧手动 Cookie 字符串 |
| `auth.cursor` | `{type:'webview'}`：已检查的 Cursor 官网会话，不保存 Cookie 或管理员密钥 |
| `display.providers` | JSON 来源 ID 数组，最多四个；空数组表示全部隐藏 |
| `usage.<id>` | 归一化用量快照，见下方 |
| `status.<id>` | 查询 / 授权错误状态，不含原始服务端响应或凭据 |

归一化用量快照字段为 `id`、`plan`、`updatedAt`（Unix 秒）、`windows`、`balance`、`credits`、`booster`、`hint`。字段不可用时不伪造为 0。Cursor 另有 `details` 安全文字数组，显示美元消费及缺少个人上限的提示，不含原始响应。

卡片的同步常显快照为 `{schemaVersion:1, config:{providers, updatedAt, emptyMessage}}`，仅含展示数据，不包含 auth 或错误响应。静态 logo 保持包内 PNG。

## MiMo 网页登录与查询

1. `requestMimoLoginUrl()` 访问 `GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage`，显式 `cookies:false` 获取平台签名的 `loginUrl`。仅接受 HTTPS 的 `account.xiaomi.com` 登录入口，不猜测或持久化签名地址。
2. 设置页调用 `window.open(url, '_blank')`，宿主在本模块 Profile 中打开无 bridge 注入的独立 WebView。用户完成登录后关闭子窗口，再点「检查登录」；不以打开窗口或页面地址判断成功。
3. `checkMimoLogin()` 以 `cookies:true` 查询真实 usage 接口，成功后保存会话类型标记与用量缓存，再通知背屏。查询失败不新增登录标记，已有来源保留上次成功数据。
4. 后续设置页刷新 / 背屏手动查询 / 后台查询统一使用 `cookies:true`；`GET https://platform.xiaomimimo.com/api/v1/tokenPlan/detail` 不可用时仍降级显示用量。
5. usage 返回 401 时复用平台签名登录入口尝试 Passport 会话恢复。每跳使用 `cookies:true, redirect:'manual'`；只跟随 `account.xiaomi.com` / `platform.xiaomimimo.com`，HTTP 地址先升级为 HTTPS，最多 8 跳。Cookie 的发送与 Set-Cookie 保存均交给宿主，不解析或复制 Cookie。Passport 最终停在交互登录页时报告授权失效；不开后台窗口，网络超时不自动重试。

「移除来源」清除 `auth.mimo`、用量和状态，不清除 Profile 的浏览器会话；桥当前没有会话清除 API，因此不把此按钮称为退出登录。模块更新保留 Profile，卸载由桥删除 Profile。旧手动 Cookie 字符串仍兼容查询，成功检查网页登录后替换为无凭据的会话类型标记。

## Cursor 网页登录与查询

1. 设置页用 `window.open('https://cursor.com/dashboard/usage', '_blank')` 在模块 Profile 的独立窗口打开官网；用户登录后关闭窗口，再点「检查登录」。
2. 检查及后续刷新以 `cookies:true` 请求 `GET https://cursor.com/api/usage-summary`。成功后仅存 `{type:'webview'}`，Cookie（含 HttpOnly 会话）留在宿主，不复制到业务存储。
3. 团队席位优先读取 `individualUsage.overall` 个人预算；其他套餐读取 `individualUsage.plan`。只有接口返回比例或明确的已用／正数上限才显示比例；共享池窗口标为「团队共享额度」，不冒充个人额度。`details` 显示个人／套餐消费与个人额外消费（接口金额按美分转换），不把花费当作余额或 Credits。
4. 401 / 403 报告授权或权限失效并保留成功缓存。后台不打开登录窗口，不自动续期。移除来源不清除 Profile 会话；该行为与 MiMo 相同。
5. 这是 Cursor 官网内部接口，不是企业管理员 Admin API；真实账号及 Android WebView / SSO 登录需设备验收。

## 后台刷新

[模块描述](<../module.json>) 声明 `background.intervalMinutes:30`。[后台源码](<../src/background/main.js>) 与共享核心拼成自包含的根目录 `background/main.js`，保持 WebView 原生 async/await，不包含 Canvas 渲染器。宿主每次创建独立 WebView，调用并等待 `refresh()`：

1. 读取已配置来源；每次宿主调用均查询，不使用模块自己的缓存年龄门槛。
2. 来源并行查询，单来源失败由核心保存安全状态、保留成功缓存，其他来源继续。
3. 调用与背屏相同的 `cardConfig()`，形成 `{schemaVersion:1,config}`，**await `bridge.card.saveSnapshot()`** 后才结束；部分来源失败在保存后用固定文案报告，宿主等下个周期，不立即重试。

后台使用 `bridge.net.request`，MiMo 复用相同 Profile。后台 Codex 不轮换 refresh token，401 时需打开设置页刷新登录；桥的任务串行并不包含用户在设置页的操作，当前没有跨环境令牌轮换锁，故继续由设置页独占续期。

用户在桥内开启统一后台刷新并设置各模块周期。所有模块共用一个一次性 JobScheduler 任务，按最早到期时间安排，到期后串行执行已到期模块并安排下次任务，单次最多 60 秒。默认周期 30 分钟，执行最短 5 分钟。系统省电可能延迟任务。

背屏先同步画快照，再异步重读共享缓存，启动不查询网络。宿主会在读取载体数据时把后台保存的最新快照同步到卡片本地缓存，常显首帧无需等待桥请求；后台不调用 Canvas、不主动唤醒背屏，不承诺每个调度周期屏幕都重绘。
