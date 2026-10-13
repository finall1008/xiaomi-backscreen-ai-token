# AI 用量背屏

Android App（`dev.finall.aitoken`）：集中查看 Codex、Kimi Code、DeepSeek 和小米 MiMo 用量，以既有 Canvas 原型生成多来源小米背屏卡片。界面使用 Miuix Compose 0.9.4。

## 使用

1. 安装 APK，在首页选择需要配置的来源：Codex 使用设备码登录（需允许 ChatGPT 设置 → 安全中的设备码登录）；Kimi Code / DeepSeek 填写 API Key；MiMo 使用小米账号网页登录或手动 Cookie。
2. 在来源详情页刷新用量，首页显示来源列表及多来源卡片预览。MiMo 按实际套餐周期展示额度与套餐截止日期；Kimi Code 展示接口可用的 5 小时 / 周额度，不展示会员月额度。
3. 安装支持 v2 协议的背屏卡片桥，选择「发送到背屏」。首次按桥接界面的流程选择载体、绑定，并在系统背屏设置重新应用卡片。后续更新沿用已绑定载体。背屏可点击来源进入详情、左右滑动切页，详情标题可点回首页。
4. 可开启后台自动刷新，间隔至少 15 分钟。Android WorkManager 的实际运行时间受网络及系统省电策略影响，并非精确定时。授权失效时保留上次数据，可通过通知进入对应来源重新授权。
5. 「导出卡片 ZIP」通过系统文件选择器保存卡片包；各来源可分别清除授权，背屏保留最后保存的内容。

## 认证与隐私

此应用使用 Codex 官方客户端的设备码流程及 ChatGPT 用量接口，不是注册独立第三方应用的「Sign in with ChatGPT」集成。接口及账号可用性可能随 OpenAI 调整而变化。构建与离线测试不能替代本人账号登录实测。

OAuth 凭据只保存在本机私有加密存储中，禁用 Android 备份与设备迁移，不进入卡片、ZIP 或日志。卡片只包含套餐、用量窗口、重置时间与更新时间；不要把设备验证码分享给别人。应用不发送模型推理请求。

## 构建

需要 JDK 21、Android SDK 37 及所有者签名配置。Debug 和 Release 均使用相同 `finall` 密钥；本地密码从 macOS 钥匙串读取，CI 从 GitHub Secrets 注入，配置缺失时拒绝构建，不回退默认 debug key。详见 [项目约定](<AGENTS.md>)。

```sh
JAVA_HOME=$(/usr/libexec/java_home -v 21) ./gradlew :app:assembleDebug :app:assembleRelease :app:testDebugUnitTest
```

手机覆盖安装必须使用 `adb install -r`，不通过卸载绕过签名冲突。

## GitHub Release

[发布工作流](<.github/workflows/release.yml>) 沿用背屏卡片桥的发布方式：

- 推送 `main` **不会**触发发布。
- 推送 `v*` tag 会运行卡片交互测试、Android 单测，构建并校验所有者签名，然后创建 GitHub Release、上传 APK。
- Actions → Release → Run workflow 可手动构建；选择普通分支时只上传 Actions artifact，不创建 Release。
- 每次正式版本先更新 [版本配置](<app/build.gradle.kts>) 的 `versionCode` / `versionName`，再提交、推送并打同名 tag。首次版本目前为 `0.1.0`，对应 `v0.1.0`。

```sh
git push origin main
git tag v0.1.0
git push origin v0.1.0
```

仓库 Actions Secrets 需要 `RELEASE_JKS_BASE64`（现有密钥的 base64）、`RELEASE_STORE_PASSWORD`、`RELEASE_KEY_ALIAS`（`finall`）、`RELEASE_KEY_PASSWORD`。不得把密钥或密码提交到 Git。工作流将密钥还原到 `signing/finall.jks`，结束后清理；发布证书必须与本地一致。

## 卡片资源

视觉保持 [既有原型](<prototype/main.js>)；仅为真实数据与运行时适配做功能性修改。OpenAI logo 随 ZIP 的 `assets/` 静态安装，不使用 Data URL，不混入日常热更新脚本。
