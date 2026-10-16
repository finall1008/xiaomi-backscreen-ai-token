# AI 用量背屏

基于 rear-card-bridge API v2 的卡片模块：在卡片桥的设置网页配置 Codex、Kimi Code、DeepSeek、小米 MiMo 与 Cursor，勾选最多四个来源，使用既有 Canvas 卡片查看用量。

## 安装与使用

1. 安装支持模块网页登录会话、统一 JobScheduler 后台调度与刷新周期设置的 rear-card-bridge，建议使用包含 MiMo 登录窗口白屏修复的 **v1.2.1 或更新版本**。系统 Android System WebView 需支持 `MULTI_PROFILE`。已有载体需要重新生成，并到系统背屏设置重新应用。
2. 在卡片桥中导入 Git 仓库 <https://github.com/finall1008/xiaomi-backscreen-ai-token>，分支 `main`。导入器读取仓库根目录的 [module.json](<module.json>)、编译后的经典卡片 `card/`、静态 `webroot/` 与 `background/`。手机上不执行 npm，也不运行构建。
3. 也可改用「安装 ZIP 模块」，从 [Releases](<https://github.com/finall1008/xiaomi-backscreen-ai-token/releases>) 下载已发布的模块 ZIP 并安装。ZIP 根目录同样是 `module.json` 与上述三份静态产物。
4. 打开模块设置：Codex 使用设备码登录；Kimi Code / DeepSeek 填写 API Key；MiMo / Cursor 点「网页登录」，登录完成关闭窗口，再点「检查登录」。每个已配置来源可勾选「在背屏显示」，最多四个；取消勾选不清除登录或用量。Codex 需要在 ChatGPT 设置 → 安全中允许设备码登录。
5. 在桥中绑定载体，并在系统背屏设置应用卡片。后续数据和脚本更新无需反复导出 ZIP；静态 logo 等资源变化仍需更新载体并重新应用。
6. 设置页可查看各来源详情、手动刷新、清除授权，并预览卡片。背屏支持点击来源进入详情、左右滑动切页、点击详情标题返回首页；首页下拉刷新全部已配置来源，详情页在顶部下拉只刷新当前来源。
7. 需要休眠期间取数时，在桥中开启后台刷新并统一设置该模块周期（默认 30 分钟，最短 5 分钟）。宿主通过系统 JobScheduler 调度，更新共享快照供背屏下次加载时读取，不主动唤醒背屏。

同一模块 id 更新时必须增加 [模块描述](<module.json>) 的 `versionCode`。当前 `version` 为 `0.3.0`，`versionCode` 为 `6`。桥保留模块 storage 和 config。

## 功能

| 功能 | 模块行为 |
| --- | --- |
| Codex | 设备码登录、用量查询、设置页 401 后续期；背屏 401 不轮换 refresh token，需打开设置页刷新 |
| Kimi Code | API Key、套餐、5 小时 / 周额度、加油包；不展示接口没有提供的会员月额度 |
| DeepSeek | API Key、余额明细 |
| 小米 MiMo | 独立窗口网页登录、检查登录、用量与套餐查询；设置页与背屏通过 `cookies:true` 共用模块会话 |
| Cursor | 官网网页登录、套餐及个人本期额度、额外消费；团队共享额度明确标注，缺少个人上限时不推算剩余额度；无需管理员密钥 |
| 背屏展示 | 设置页勾选最多四个已配置来源，保持 2×2 总览；隐藏来源仍可在设置页查看、刷新，后台仍取数 |
| MiMo 会话恢复 | 平台返回 401 时尝试现有 Passport 会话恢复；需交互登录时提示重新登录，后台不开窗口 |
| 刷新 | 设置页保存凭据后查询、手动刷新；背屏首页下拉刷新全部来源，详情下拉只刷新当前来源；失败保留上次成功数据 |
| 休眠期间后台刷新 | 宿主调度独立后台入口，每次查询全部已配置来源并保存共享快照；失败保留成功数据，不主动唤醒背屏 |
| 后台 Codex 授权 | 与背屏一致不轮换 refresh token，避免和设置页并发轮换；401 后需在设置页刷新登录 |
| 授权过期通知 | 错误写入来源状态并保留旧数据；未实现专门的授权通知 |
| 常显 | 启动先同步恢复无凭据快照，在最初动画帧绘制，不等待网络 |

刷新周期由桥统一管理，模块不设独立定时器或缓存年龄门槛。背屏启动与缓存通知只读取已有数据，下拉会直接查询。系统休眠时背屏 JS 不执行，后台保存的新快照在宿主下次读取载体数据时同步到首帧；系统省电可能延迟 JobScheduler 任务。

Codex 使用官方客户端设备码与 ChatGPT 用量接口。Cursor 使用官网未公开的 `GET https://cursor.com/api/usage-summary`，不是官方 Admin API；兼容个人套餐和接口返回的团队席位个人预算／共享池，缺少额度不显示为 0。Cursor 会话过期后需重新网页登录，不自动续期；手机 WebView 的登录与团队 SSO 需本人账号实测。接口及账号可用性可能随服务端变化，离线测试不能替代本人账号实测。

Cursor 静态图标来自 [Lobe Icons](<https://github.com/lobehub/lobe-icons>)，随载体资源安装；升级增加此图标后需更新载体并重新应用。

## 数据与凭据

Codex 令牌和 Kimi / DeepSeek 密钥保存在卡片桥本机私有 `bridge.storage` 中，暂不加密。MiMo / Cursor 网页登录的 Cookie 由宿主保存在本模块独立 WebView Profile，业务存储只记录 `{type:'webview'}` 标记。凭据、响应头与签名登录地址不进入模块 ZIP、日志、预览消息或常显快照，不发送模型推理请求。

清除授权会移除该来源凭据和缓存，并通知背屏重读数据。MiMo / Cursor「移除来源」仅停用来源并清除业务缓存，不清除 Profile 中的网页登录会话；桥未提供清除会话 API。卸载模块会删除模块数据与 Profile。旧模块保存的手动 Cookie 仍可查询，成功「检查登录」后切换到 Profile 会话，不再复制 Cookie。

## 开发与构建

需要 Node **22.18+（22.x）或 24.11+**。

```sh
npm ci --ignore-scripts
npm test
npm run build
```

`npm run build` 写出仓库根目录的安装产物，并另外生成发布用 ZIP（输出到 `dist/`）：

- `card/`：经典卡片 JS，仅把 async/await 编译成生成器；静态 logo 在 `card/assets/`。
- `webroot/`：已构建的静态设置页，保持浏览器原生异步。
- `background/`：自包含后台入口，保持 WebView 原生 async/await。

这三份根目录产物必须提交。手机导入 `main` 时直接使用已提交的文件。直接用浏览器打开构建出的 `webroot/index.html` 时没有原生 bridge，页面会提示在卡片桥中打开，不会回退到 localStorage 保存真实凭据。

- [共享业务逻辑](<src/shared/core.js>)：请求协议、解析、登录、缓存，供 WebUI 与背屏共用。
- [模块运行入口](<src/card/main.js>)、[启动快照](<src/card/bootstrap.js>)：使用桥 API，不依赖浏览器 fetch。
- [后台入口](<src/background/main.js>)：构建时拼接共享核心，宿主一次调用 `refresh()`，查询后 await 保存与背屏同格式的快照，不绘图、不设定时器。
- [设置网页](<src/webui/index.html>)：普通 WebView 页面；第一个脚本是宿主提供的 bridge shim。
- [卡片原型](<prototype/main.js>)：既有布局和交互，新增数据更新入口；同一渲染代码用于模块与预览。
- [模块构建脚本](<scripts/build-module.mjs>)：与桥的 card-build 使用相同锁定 Babel / ZIP 依赖，仅将 card 下 async/await 编译成生成器；WebUI 保持浏览器原生异步。静态 logo 随 assets 安装，不以内联图片热更新。
- [桥接对接说明](<docs/bridge-handoff.md>)：网页登录协议、后台调度与共享快照约定。

Node 测试覆盖现有触摸交互、协议解析 / 登录流程、编译产物、缓存联动和常显首帧。真机的网页登录、背屏联网、休眠恢复仍需在设备验收。

## 发布

[发布工作流](<.github/workflows/release.yml>) 发布模块 ZIP，Git 导入使用已提交的根目录产物：

- 推送 main 不创建 GitHub Release。`main` 是导入安装分支，功能改动后必须提交 `npm run build` 生成的根目录 `card/`、`webroot/`、`background/`。
- `v*` tag 运行测试、构建模块并创建 GitHub Release，附件为 `dist/ai-usage-<version>.zip`。
- tag 必须匹配模块描述的 `version`，更新安装时 `versionCode` 必须递增。
- 手动 workflow_dispatch 只在 tag 上创建 Release，普通分支仅上传 Actions artifact。
