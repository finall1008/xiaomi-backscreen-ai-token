# 项目约定

## Git 提交身份

- 本仓库固定使用 `finall1008 <wymxx55@outlook.com>` 作为 Git author 和 committer。
- 在仓库本地配置 `user.name=finall1008`、`user.email=wymxx55@outlook.com`，不得切换身份或修改全局 Git 配置。

## APK 签名与安装

- Debug 和 Release 始终使用与隔壁舞萌、卡片桥工程一致的所有者 `finall` 签名，不得使用默认 debug key、生成新密钥或切换签名。
- 构建使用仓库相对路径 [signing/finall.jks](<signing/finall.jks>)，alias 为 `finall`。
- 密码仅从 macOS 钥匙串读取。service 和 account 在本机 [signing/signing.properties](<signing/signing.properties>) 中配置（字段 `keychainService`、`keychainAccount`）。整个 `signing/` 目录已在 [.gitignore](<.gitignore>) 中忽略，禁止提交密钥、本机签名配置，禁止打印或落盘密码。
- 密钥或钥匙串不可用时停止构建，不做替代。
- 手机安装必须 `adb install -r` 覆盖保留数据。遇到签名冲突报告错误，不得卸载用户应用绕过。

## 界面与背屏卡片

- Android App 使用 Miuix Compose 0.9.4 标准控件，不自制控件。
- 背屏卡片直接采用 [原型](<prototype/main.js>) 的既有视觉设计，禁止擅自重新设计。只允许真实数据、运行时适配所必要的功能性修改。
- OpenAI logo 是静态资源，随载体 ZIP 的 assets/ 目录安装，不以内联图片方式参与日常脚本热更新。
- OAuth 凭据只在本机私有加密存储中保存，禁用备份；不得写入日志、卡片、导出 ZIP 或仓库。
