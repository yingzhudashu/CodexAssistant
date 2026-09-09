# 安装包与发布

当前 Windows 下载版本为 `2.0.6`，Android 为 `2.0.5`；Android `versionCode=8`，协议固定为 `codex-assistant.v2`。各端版本来源分别是 `apps/desktop/package.json` 与 `android/app/build.gradle.kts`。本次运行证据增强在 Windows 采集端生效；Android 直接接收修正快照，服务端协议和数据库无需变更。

## 构建

```powershell
npm run build
npm test
.\scripts\build-windows-production.ps1
.\scripts\build-android-production.ps1 -SigningProperties C:\secure\codexassistant\android-release.properties
```

Windows 脚本构建 Electron 与 NSIS、计算 SHA-256 并复制到 `artifacts/windows`。当前配置禁用 Authenticode 签名，清单必须如实标记 `NotSigned`；不能声称包具有受信任的发布者签名。NSIS 使用项目图标，Electron 可执行文件资源编辑目前禁用。

若下载运行时的网络不可达，可显式复用项目已经安装的同版本 Electron：先运行 `npm run build`，再在 `apps/desktop` 中执行 `..\..\node_modules\.bin\electron-builder.cmd --win nsis --publish never --config.electronDist=../../node_modules/electron/dist`。执行前核对 `node_modules/electron/dist/version` 与桌面 package.json 中的 Electron 依赖版本一致；不能使用不明来源或不同版本的运行时。

Android 脚本执行 `assembleRelease`、启用 R8，使用仓库外 keystore 签名，随后执行 apksigner 验证并计算 SHA-256；产物位于 `artifacts/android`。缺少签名配置直接失败。必须保留同一 keystore 才能覆盖安装，密码不得写进日志或仓库。

Android 回归命令：在 `android` 目录运行 `.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug :app:lintDebug --no-daemon`。构建通过不等于真实设备后台验收通过。

## 下载清单

服务器下载目录为 `/srv/www/codex-assistant/downloads`，公网入口为 `https://server.example.com/codex-assistant/downloads/`。EXE/APK 文件名包含版本且使用长期不可变缓存，发布后不能用不同字节覆盖同名文件。

先上传并核对每个安装包的 SHA-256，再发布 UTF-8 无 BOM 的 `manifest.json`。清单通过 `no-store` 禁止缓存；应使用临时文件与 rename 原子替换。最后通过公网下载完整文件并再次比对哈希。

清单包含 `product=CodexAssistant`、`protocolVersion`、`releasedAt`、顶层 Windows `version`，以及 `downloads.windows` 与 `downloads.android`。两者都必须包含 `url`、`file`、`sha256`、`sizeBytes`、`versionName`；Windows 还包含 `signatureStatus`，Android 还包含递增的 `versionCode`。Android 检查更新只读取当前约定字段，网络与解析都在 IO 线程执行，按 versionCode 判断新版本；下载按钮打开系统浏览器，不自动覆盖安装。

两个构建脚本生成的本地 manifest.json 只是各平台构建信息，不是线上联合清单，不能直接覆盖服务器清单。Windows 本地产物名为 `CodexAssistant Setup <版本>.exe`，上传时按线上约定命名为 `CodexAssistant-<版本>.exe`；哈希针对实际上传字节计算。只发布一个平台时，从现有线上清单保留另一个平台的全部信息。

Windows 当前仅比较顶层 version 字符串是否与已安装版本不同，没有实现语义版本高低比较；Android 按 versionCode 判断是否更新。桌面没有 Android 同等的清单结构和大小校验。下载交给浏览器，两端都不会自动验证所下载文件的 SHA-256；发布端的完整下载校验不能省略。

## 服务端与回滚

客户端修复若未改变协议或 schema，不需要删除服务端数据。服务端通过 `scripts/deploy-production.ps1` 发布独立 release 并检查 health。回滚只切换已验证的 release；schema 不同直接拒绝，不执行 migration。安装包、APK、签名材料和测试截图均不提交到版本库。

当前部署脚本只在记录上一 current 目标后才能自动切回。较早阶段失败时可能移除 current 并停止服务；脚本不会备份恢复 systemd unit 或 Nginx snippet，Nginx 主配置也仅在新增 include 时备份。配置变更前需人工备份上述文件并准备恢复命令，不能依赖脚本完成完整回滚。成功部署保留最近五份服务 release；此策略不清理下载目录中的安装包。

确认安装包已发布后，可用 `npm run clean -- -WhatIf` 查看本地清理范围，再运行 `npm run clean` 删除生成物。源码、版本声明和文档变更提交 Git，二进制包不提交。
