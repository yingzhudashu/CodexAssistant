# 构建与发布

发布状态：**已发布**。当前 Windows `2.0.16`，Android `2.0.15`（`versionCode=18`），协议 `codex-assistant.v3`，SQLite schema=6。2026-09-16 已部署至 `deployment-host`，生产 release 为 `private-release-id`，并原子更新公网联合清单。

当前下载：[Windows 2.0.16](https://server.example.com/codex-assistant/downloads/CodexAssistant-2.0.16.exe)、[Android 2.0.15](https://server.example.com/codex-assistant/downloads/CodexAssistant-2.0.15.apk)。两端已完整下载校验SHA-256；清单缓存为no-store，安装包缓存为immutable。产物大小、哈希和实际运行测试边界见[验收记录](acceptance.zh-CN.md#构建与交付状态)。

## 质量门

```powershell
npm ci
npm run build
npm test
npm run check:format
npm run check:docs
npm run check:design
python docs/frontend-design/validate.py
npm run test:ui
npm run perf:server
```

Android 在 android 目录执行 `.\gradlew.bat checkKotlinFormat :app:testDebugUnitTest :app:assembleDebug :app:lintDebug`。记录实际通过数、警告和测试边界；不得以构建成功替代真机或消息发送验收。

## 安装包

```powershell
.\scripts\build-windows-production.ps1
.\scripts\build-android-production.ps1 -SigningProperties C:\secure\codexassistant\android-release.properties
```

Windows 构建复用项目安装的同版本 Electron，打包 NSIS 至 artifacts/windows，记录体积、SHA-256、signatureStatus。当前配置明确未签名（NotSigned），不能声称可信发布者；不自动安装到本机。构建先清理 dist，避免旧产物递归装入安装包。

Android Release 使用仓库外 keystore、R8 和 apksigner 校验，输出 artifacts/android。缺签名材料直接失败，不创建替代签名、不冒充 release。Debug APK 用调试签名；若与已安装包签名不同，不能覆盖安装。仅专用模拟器可以重置合成测试应用。

## 联合下载清单

服务器目录 `/srv/www/codex-assistant/downloads`。版本化文件不可变，不能覆盖同名不同字节的包。先上传并完整下载比对 SHA-256，再以临时文件加 rename 原子替换无 BOM 的 manifest.json；清单 no-store，安装包一年 immutable 缓存。

联合清单包含 product、protocolVersion、releasedAt、顶层 Windows version、downloads.windows/android；平台项包含 url、file、sha256、sizeBytes、versionName，Windows 附 signatureStatus，Android 附递增 versionCode。两份本地构建 manifest 不是联合清单。只发布一端时保留另一端经核实的完整信息。

当前两端联合发布使用 `scripts/publish-clients-production.ps1 -Server deployment-host`。脚本核对源码版本、本地文件大小和哈希，再上传到独立临时目录；拒绝版本倒退及覆盖同名不同内容的安装包。经公网 HTTPS 完整下载校验两份安装包后，原子切换联合清单，并从本机再次检查公网清单。上传或包校验失败时保留旧清单及现场；原始产物清单位于 artifacts，不写入源码。

Windows 用 semver 比较版本，Android 用 versionCode；无效清单报错。下载仅交给系统浏览器，应用不自动安装或验证下载哈希。只有清单成功返回后才能提示是否有更新。

## 服务端与回滚

`scripts/deploy-production.ps1` 会修改目标服务器，依赖 SSH/scp/sudo、配置中 Node 路径和既有主站 Nginx 文件；调用前必须明确目标和发布授权。本轮已按用户部署授权执行，同schema保留现有业务数据。

脚本安装不可变 release，记录原 current，并备份 systemd unit、Nginx snippet/主配置至 `/var/backups/codex-assistant/<release-id>`。schema 不匹配时停服务，保存旧库及 WAL/SHM，再建立空状态；同 schema 保留业务数据。失败时恢复配置、旧状态和 current，失败的新状态单独保留。回滚是部署故障恢复，不是协议兼容或迁移。

成功后检查回环/公网 health、Token 鉴权、实际快照；客户端消息还需单独明确授权的验收会话。真实 OEM 后台、签名信任、生产资源限额分别验收。

`scripts/acceptance/production-readonly.mjs` 在目标服务器执行，读取既有环境凭据，检查公网鉴权、HTTP/WS 快照、Trace 父节点及订阅释放。只输出计数与布尔结果，不写业务事件、不发送消息、不打印任务正文或 Token；执行方式见[验收脚本说明](../scripts/acceptance/README.md#生产部署后只读检查)。

安装包与原始报告不提交 Git。需要保留最终交付物时先复制到工作区之外，再执行 `npm run clean -- -WhatIf` / `npm run clean`。
