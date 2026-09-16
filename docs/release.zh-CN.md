# 构建与发布

发布状态：**已发布**。当前 Windows `2.0.16`，Android `2.0.16`（`versionCode=19`），协议 `codex-assistant.v3`，SQLite schema=6。私有部署的联合清单与已发布安装包核验一致；实际主机、域名、release和备份标识仅保存于仓库外。

下载路径示例（`server.example.com` 为占位域名，不提供实际下载）：[Windows 2.0.16](https://server.example.com/codex-assistant/downloads/CodexAssistant-2.0.16.exe)、[Android 2.0.16](https://server.example.com/codex-assistant/downloads/CodexAssistant-2.0.16.apk)。两端已完整下载校验SHA-256；清单缓存为no-store，安装包缓存为immutable。产物大小、哈希和实际运行测试边界见[验收记录](acceptance.zh-CN.md#构建与交付状态)。

Android 2.0.16为后台通知修复：独立记录变化、重连补报、固定速率发送、关键状态声音独立节流、specialUse持续订阅及用户电池豁免入口。修复包已发布；此次服务端重新部署复用已验证的两端2.0.16安装包，文件哈希保持不变，未覆盖不可变版本文件。联合清单、两份本地安装包与服务器文件的SHA-256和大小已重新核验。

## 客户端升级指引

|组件|当前版本与操作|
|---|---|
|Windows|已安装2.0.16无需重复安装；更早版本应更新至2.0.16，取得桌面采集、outbox、Trace和界面优化。Android后台通知补丁未修改Windows代码。|
|Android|更早版本应更新至2.0.16/code19；已安装该正式包无需重复安装。此次后台通知修复需要设备安装新APK，仅部署服务器不会生效。|
|服务端|实际release见仓库外部署记录；协议v3、schema6。本次重新部署保留现有业务数据，不要求已经使用当前版本的客户端重装。|

Windows在“关于与更新”、Android在设置页点击“检查更新”后，通过系统浏览器下载安装包，也可使用本页下载链接。应用不会静默安装更新。Windows升级前从托盘菜单“退出”停止工作站，安装后重新打开并检查连接和采集状态；仅关闭窗口会继续在托盘运行。Android安装后打开应用，确认连接成功，并在设置→通知核对系统通知权限、提醒渠道和电池优化状态；需要息屏及时接收时，点击“允许后台持续连接”并在系统界面确认。部分厂商还需设置自启动和后台运行权限，排查方式见[运维手册](operations.zh-CN.md#android-生命周期)。

Android正式包使用既有Release签名；Debug包与正式包签名不同，不能覆盖安装。不要通过卸载应用来处理普通通知延迟，先按运维指引检查连接和系统限制。覆盖安装、真实手机长期后台运行的实测范围以[验收记录](acceptance.zh-CN.md#未覆盖与发布门槛)为准。

构建源码、生成安装包、发布下载文件和部署服务端是不同操作。最近一次服务部署执行了`npm run build`，包含Windows源码编译；Windows已发布安装包继续使用经校验的2.0.16文件。本次未重新生成NSIS安装包，也未发布新的Windows版本。后续客户端代码发生变化时，应提升对应客户端版本后构建并发布，禁止覆盖同名不同内容的安装包。

## 质量门

```powershell
npm ci
npm run build
npm test
npm run check:format
npm run check:docs
npm run check:privacy
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

当前两端联合发布使用 `scripts/publish-clients-production.ps1 -Server deployment-host -PublicOrigin https://server.example.com`。主机和HTTPS根地址均须显式传入，示例值不是可用的生产配置。脚本核对源码版本、本地文件大小和哈希，再上传到独立临时目录；拒绝版本倒退及覆盖同名不同内容的安装包。经公网HTTPS完整下载校验两份安装包后，原子切换联合清单，并从本机再次检查公网清单。上传或包校验失败时保留旧清单及现场；原始产物清单位于artifacts，不写入源码。

Windows 用 semver 比较版本，Android 用 versionCode；无效清单报错。下载仅交给系统浏览器，应用不自动安装或验证下载哈希。只有清单成功返回后才能提示是否有更新。

## 服务端与回滚

`scripts/deploy-production.ps1` 会修改目标服务器，依赖 SSH/scp/sudo、配置中 Node 路径和既有主站 Nginx 文件；调用前必须明确目标和发布授权。本轮已按用户部署授权执行，同schema保留现有业务数据。

脚本安装不可变 release，记录原 current，并备份 systemd unit、Nginx snippet/主配置至 `/var/backups/codex-assistant/<release-id>`。schema 不匹配时停服务，保存旧库及 WAL/SHM，再建立空状态；同 schema 保留业务数据。失败时恢复配置、旧状态和 current，失败的新状态单独保留。回滚是部署故障恢复，不是协议兼容或迁移。

成功后检查回环/公网 health、Token 鉴权、实际快照；客户端消息还需单独明确授权的验收会话。真实 OEM 后台、签名信任、生产资源限额分别验收。

`scripts/acceptance/production-readonly.mjs` 在目标服务器执行，读取既有环境凭据，检查公网鉴权、HTTP/WS 快照、Trace 父节点及订阅释放。只输出计数与布尔结果，不写业务事件、不发送消息、不打印任务正文或 Token；执行方式见[验收脚本说明](../scripts/acceptance/README.md#生产部署后只读检查)。

安装包与原始报告不提交Git。真实部署地址、SSH别名、站点配置文件名、release和备份标识、业务计数仅保存于仓库外；公开材料使用 `server.example.com`、`deployment-host` 和 `<release-id>`。已有发布文件可能包含旧的内置地址或应用标识，源码脱敏不会改变已发布字节；下一次发布必须提高版本并重新验收，不覆盖原文件。本次仅完成源码与材料脱敏，未发布替换安装包。Android后续Release构建首次启动不预填服务器，Windows应用标识统一为 `site.codexassistant`，安装身份变更后的覆盖安装需要单独验收。

需要保留最终交付物时先复制到工作区之外，再执行 `npm run clean -- -WhatIf` / `npm run clean`。
