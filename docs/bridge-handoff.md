# 桥侧对接：网页登录与后台刷新

模块接入桥的模块网页登录、统一 JobScheduler 后台调度与统一周期设置，使用 API v2。

## 当前模块布局

模块 id 为 `dev.finall.aitoken`，`version` 为 `0.4.2`，`versionCode` 为 `10`，声明 `network` / `storage`。Git 导入读取仓库根目录，手机不执行 npm：

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
| `display.page` | `minimal` / `overview` / `provider:<id>`，稳定页标识，不用数组下标 |
| `display.wallpapers` | `{revision, images:[id...]}`，小体积图库目录；清空也写入新版本 |
| `wallpaper.<id>` | `{id,name,sharp,blur,width,height}`，两份 JPEG Data URL；逐张读写，避免多个大值进入同一 HostVar 批次 |
| `usage.<id>` | 归一化用量快照，见下方 |
| `status.<id>` | 查询 / 授权错误状态，不含原始服务端响应或凭据 |

归一化用量快照字段为 `id`、`plan`、`updatedAt`（Unix 秒）、`windows`、`balance`、`credits`、`booster`、`hint`。字段不可用时不伪造为 0。Cursor 另有 `details` 安全文字数组，显示美元消费及缺少个人上限的提示，不含原始响应。

卡片的同步常显快照为 `{schemaVersion:1, config:{providers, updatedAt, emptyMessage}, page?, appearance?:{revision,images:[完整图片...]}, wallpaperId?}`，仅含展示数据，不包含 auth 或错误响应；兼容旧版没有壁纸和页码的 v1 快照。静态 logo 保持包内 PNG。

壁纸与页码由 [共享展示逻辑](<../src/shared/appearance.js>) 合并保存，设置页与后台更新用量时不得覆盖掉这些字段。图库总量按真实的完整快照 JSON 检查 800×1024 字符，不另设图库张数限制。单张清晰图不超过 180K、模糊图不超过 30K，低于 storage 单值 256K 限制；设置页先检查完整快照，再写图库和快照，超限保留原图库。

[启动入口](<../src/card/bootstrap.js>) 在渲染器执行前同步读取完整快照、选择下一张、恢复页码并写回选择结果。首帧图像源直接使用快照里的 Data URL，不依赖异步 storage、文件 URL 或网络解码。原生图片在赋值时 `complete=true` 且尺寸有效，就立即纳入绘制：模拟器实测 Data URL 已同步解码，但 `onload` 排在第一帧之后，仅等待回调会漏掉首帧壁纸。异步加载图库仅用于接收设置变更，同次运行刷新数据不推进轮换。翻页即保存稳定页标识；来源被移除导致页码失效时回到现有默认页。

页码和轮换位置另同步写入原生 `localStorage` 的 `aiUsage.presentation`（只含 `page`、`wallpaperId`、`appearanceRevision`），在启动读取共享快照后恢复。宿主首次注入共享快照会替换 `bridge_snapshot`，这一小份本地记录避免刚翻页便熄屏时被尚未确认的共享副本覆盖；图库版本变化后不恢复旧图片选择。

AOD 恢复监听 `visibilitychange`。原生直接 OFF/ON 不发送该事件，也不保证重建 JS，因此还在宿主已有 RAF 循环中观察超过 1 秒的回调中断：恢复时保持当前页、选择下一张并请求重绘。普通帧只检查时间，不绘图、不读写存储、不查询桥；事件和回调恢复共用同一状态，避免同次恢复推进两次。这是缺少 OFF/ON 事件的兼容处理，超过 1 秒的运行时卡顿也会被视为恢复。

宿主文件选择器需识别 `FileChooserParams.MODE_OPEN_MULTIPLE` 并返回全部 URI，单选协议不变。

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
3. 调用与背屏相同的 `cardConfig()`，与已有快照合并，保留图库、壁纸选择及页码，**await `bridge.card.saveSnapshot()`** 后才结束；部分来源失败在保存后用固定文案报告，宿主等下个周期，不立即重试。

后台使用 `bridge.net.request`，MiMo 复用相同 Profile。后台 Codex 不轮换 refresh token，401 时需打开设置页刷新登录；桥的任务串行并不包含用户在设置页的操作，当前没有跨环境令牌轮换锁，故继续由设置页独占续期。

用户在桥内开启统一后台刷新并设置各模块周期。所有模块共用一个一次性 JobScheduler 任务，按最早到期时间安排，到期后串行执行已到期模块并安排下次任务，单次最多 60 秒。默认周期 30 分钟，执行最短 5 分钟。系统省电可能延迟任务。

背屏先同步画快照，再异步重读共享缓存，启动不查询网络。宿主会在读取载体数据时把后台保存的最新快照同步到卡片本地缓存，常显首帧无需等待桥请求；后台不调用 Canvas、不主动唤醒背屏，不承诺每个调度周期屏幕都重绘。
