# 项目约定

## Git 提交身份

- 本仓库固定使用 `finall1008 <wymxx55@outlook.com>` 作为 Git author 和 committer。
- 在仓库本地配置 `user.name=finall1008`、`user.email=wymxx55@outlook.com`，不得切换身份或修改全局 Git 配置。

## 模块仓库

- 本仓库是 rear-card-bridge 卡片模块。Git 导入读取根目录 [module.json](<module.json>) 以及 `npm run build` 生成的 `card/`、`webroot/`、`background/`；这三份编译产物必须随功能改动提交。手机不执行 npm。
- 当前版本为 `0.2.2`，versionCode 为 `4`。同一模块 id 更新安装时必须递增 `versionCode`。

## 界面与背屏卡片

- 背屏卡片直接采用 [原型](<prototype/main.js>) 的既有视觉设计，禁止擅自重新设计。只允许真实数据、运行时适配所必要的功能性修改。
- OpenAI logo 是静态资源，随载体 ZIP 的 assets/ 目录安装，不以内联图片方式参与日常脚本热更新。
- 模块令牌 / API Key 保存在卡片桥本机私有 `bridge.storage` 中，暂不要求加密；MiMo 网页登录 Cookie 由宿主保存在模块独立 WebView Profile，业务存储仅保存会话类型标记。凭据不得写入日志、Canvas 展示数据、常显快照、预览消息、导出 ZIP 或仓库。
