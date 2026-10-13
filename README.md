# AI 用量背屏

Android App（`dev.finall.aitoken`）：通过 Codex 设备码登录读取套餐用量，以既有 Canvas 原型生成小米背屏卡片。界面使用 Miuix Compose 0.9.4。

## 使用

1. 安装 APK，选择「连接 OpenAI · Device Code」。复制验证码，在 OpenAI 官方网页完成登录。若账号尚未允许设备码登录，先在 ChatGPT 设置 → 安全中开启。
2. 登录完成后显示真实用量及卡片预览。「刷新套餐用量」读取最新数据。
3. 安装支持 v2 协议的背屏卡片桥，选择「发送到背屏」。首次按桥接界面的流程选择载体、绑定，并在系统背屏设置重新应用卡片。后续更新沿用已绑定载体。
4. 可开启后台自动刷新，间隔至少 15 分钟。Android WorkManager 的实际运行时间受网络及系统省电策略影响，并非精确定时。
5. 「导出卡片 ZIP」通过系统文件选择器保存卡片包；「退出登录」清除本机凭据并关闭自动刷新，背屏保留最后保存的内容。

## 认证与隐私

此应用使用 Codex 官方客户端的设备码流程及 ChatGPT 用量接口，不是注册独立第三方应用的「Sign in with ChatGPT」集成。接口及账号可用性可能随 OpenAI 调整而变化。构建与离线测试不能替代本人账号登录实测。

OAuth 凭据只保存在本机私有加密存储中，禁用 Android 备份与设备迁移，不进入卡片、ZIP 或日志。卡片只包含套餐、用量窗口、重置时间与更新时间；不要把设备验证码分享给别人。应用不发送模型推理请求。

## 构建

需要 JDK 21、Android SDK 37 及本机所有者签名配置。Debug 和 Release 均使用相同 `finall` 密钥；密码仅从 macOS 钥匙串读取，配置缺失时拒绝构建，不回退默认 debug key。详见 [项目约定](<AGENTS.md>)。

```sh
JAVA_HOME=$(/usr/libexec/java_home -v 21) ./gradlew :app:assembleDebug :app:assembleRelease :app:testDebugUnitTest
```

手机覆盖安装必须使用 `adb install -r`，不通过卸载绕过签名冲突。

## 卡片资源

视觉保持 [既有原型](<prototype/main.js>)；仅为真实数据与运行时适配做功能性修改。OpenAI logo 随 ZIP 的 `assets/` 静态安装，不使用 Data URL，不混入日常热更新脚本。
