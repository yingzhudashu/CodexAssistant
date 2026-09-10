# 安装包与发布

当前源码 Windows 版本为 `2.0.12`，Android 为 `2.0.10`；Android `versionCode=13`，协议固定为 `codex-assistant.v3`。本次修复 Android 二级页导航和返回、统一两端四种状态筛选、分离 Windows 本机就绪与云端同步状态，并改用 ICO 托盘资源。本轮协议升级v3、数据库schema=6，需要部署全新数据库；不迁移旧状态。

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

Windows 使用 semver 比较顶层 version，仅提示更高的有效版本；Android 按 versionCode 判断是否更新。桌面没有 Android 同等的清单结构和大小校验。下载交给浏览器，两端都不会自动验证所下载文件的 SHA-256；发布端的完整下载校验不能省略。

## 服务端与回滚

客户端修复若未改变协议或 schema，不需要删除服务端数据。服务端通过 `scripts/deploy-production.ps1` 发布独立 release 并检查 health。回滚只切换已验证的 release；schema 不同直接拒绝，不执行 migration。安装包、APK、签名材料和测试截图均不提交到版本库。

部署脚本在修改前记录 current 并备份 systemd unit、Nginx snippet 和主配置到 /var/backups/codex-assistant/<release-id>。schema 不匹配时停止服务，将原数据库及 WAL/SHM 保存到该备份目录后创建干净状态。失败时恢复配置、旧状态及 current，再重启旧服务；失败的新状态单独保留，不覆盖旧库。成功后保留恢复备份。回滚是发布故障恢复，不是协议兼容或 migration。

确认安装包已发布后，可用 `npm run clean -- -WhatIf` 查看本地清理范围，再运行 `npm run clean` 删除生成物。源码、版本声明和文档变更提交 Git，二进制包不提交。


## 2026-09-10 修复验收

本轮设计修订和实现验收的最新证据见 [验收记录](acceptance.zh-CN.md)。历史安装包和旧测试计数不作为本轮通过依据。

2026-09-10 已部署生产 release `private-release-id`，并发布 Windows 2.0.12 与 Android 2.0.10（versionCode=13）及联合清单。旧数据库与旧下载清单保存在 `/var/backups/codex-assistant/private-release-id`。线上检查与保留限制以 [验收记录](acceptance.zh-CN.md) 为准。Electron 更新为 44.3.0，ws 为 8.21.3。
