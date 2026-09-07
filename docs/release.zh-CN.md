# 生产安装包

## Android

Android release 必须具备独立 release keystore。将真实配置放到用户目录外的受限文件，再执行：

```powershell
.\scripts\build-android-production.ps1 -SigningProperties C:\secure\codexassistant\android-release.properties
```

脚本会执行 `clean assembleRelease`、启用 R8、校验 APK 签名和 SHA-256，并输出到 `artifacts/android`。没有签名配置会直接失败，不会生成伪生产包。Android 包名为 `site.codexassistant`，版本从 `android/app/build.gradle.kts` 读取。后台通知由 Android 前台服务负责，不需要第三方推送凭据。

## Windows

Windows NSIS 安装包必须使用组织的 Authenticode 证书：

```powershell
$env:CSC_LINK = 'C:\secure\certificates\codexassistant.p12'
$env:CSC_KEY_PASSWORD = '<certificate-password>'
.\scripts\build-windows-production.ps1
```

脚本会构建 Electron、生成 NSIS、复制到 `artifacts/windows` 并计算 SHA-256。没有 `CSC_LINK` 会硬失败；自签名证书不满足生产信任要求。

## 发布下载

下载目录由服务部署脚本创建为 `/srv/www/codex-assistant/downloads`，公网入口为 `https://robotclaw.site/codex-assistant/downloads/`。发布时只上传已经校验哈希的 APK/EXE 和 `manifest.json`，不得上传 keystore、证书私钥或 Token。Android 不依赖任何推送供应商凭据。

## 当前发布状态

源码版本为 `2.0.0`，协议为 `codex-assistant.v2`。发布前必须重新构建桌面端、服务端和 Android，完成签名、静态检查、自动化测试、真实设备验收和公网 health 检查；仓库不保存安装包、APK、签名材料或部署产物。

签名配置必须放在仓库外的受限路径。密码不写入仓库、文档或日志，并应另行离线备份，否则无法发布后续 Android 更新。
