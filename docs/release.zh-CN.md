# 安装包与发布

当前 Windows 和 Android 下载版本均为 `2.0.4`；Android `versionCode=7`，协议固定为 `codex-assistant.v2`。各端版本来源分别是 `apps/desktop/package.json` 与 `android/app/build.gradle.kts`。

## 构建

```powershell
npm run build
npm test
.\scripts\build-windows-production.ps1
.\scripts\build-android-production.ps1 -SigningProperties C:\secure\codexassistant\android-release.properties
```

Windows 脚本构建 Electron 与 NSIS、计算 SHA-256 并复制到 `artifacts/windows`。当前配置禁用 Authenticode 签名，清单必须如实标记 `NotSigned`；不能声称包具有受信任的发布者签名。NSIS 使用项目图标，Electron 可执行文件资源编辑目前禁用。

Android 脚本执行 `assembleRelease`、启用 R8，使用仓库外 keystore 签名，随后执行 apksigner 验证并计算 SHA-256；产物位于 `artifacts/android`。缺少签名配置直接失败。必须保留同一 keystore 才能覆盖安装，密码不得写进日志或仓库。

Android 回归命令：在 `android` 目录运行 `.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug :app:lintDebug --no-daemon`。构建通过不等于真实设备后台验收通过。

## 下载清单

服务器下载目录为 `/srv/www/codex-assistant/downloads`，公网入口为 `https://robotclaw.site/codex-assistant/downloads/`。EXE/APK 文件名包含版本且使用长期不可变缓存，发布后不能用不同字节覆盖同名文件。

先上传并核对每个安装包的 SHA-256，再发布 UTF-8 无 BOM 的 `manifest.json`。清单通过 `no-store` 禁止缓存；应使用临时文件与 rename 原子替换。最后通过公网下载完整文件并再次比对哈希。

清单包含 `product=CodexAssistant`、`protocolVersion`、`releasedAt`、顶层 Windows `version`，以及 `downloads.windows` 与 `downloads.android`。两者都必须包含 `url`、`file`、`sha256`、`sizeBytes`、`versionName`；Windows 还包含 `signatureStatus`，Android 还包含递增的 `versionCode`。Android 检查更新只读取当前约定字段，网络与解析都在 IO 线程执行，按 versionCode 判断新版本；下载按钮打开系统浏览器，不自动覆盖安装。

## 服务端与回滚

客户端修复若未改变协议或 schema，不需要删除服务端数据。服务端通过 `scripts/deploy-production.ps1` 发布独立 release 并检查 health。回滚只切换已验证的 release；schema 不同直接拒绝，不执行 migration。安装包、APK、签名材料和测试截图均不提交到版本库。
