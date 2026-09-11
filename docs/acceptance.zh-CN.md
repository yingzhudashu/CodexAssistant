# CodexAssistant 升级验收记录

验收日期：2026-09-10。功能验收候选版本为 Windows 2.0.11、Android 2.0.9（versionCode 12）；最终发布版本为 Windows 2.0.12、Android 2.0.10（versionCode 13）。最终版本仅递增发布元数据，以避免覆盖线上已存在的同名不可变安装包；两端已重新构建，Android 签名验证及最终 43 项 Node 回归通过。唯一协议为 `codex-assistant.v3`，API 前缀为 `/codex-assistant/api/v3`，SQLite schema 为 `6`。旧协议、旧状态和旧数据库直接拒绝；没有兼容端点、migration 或 fallback。生产已按运维文档启用全新 schema 6 数据库，两端新包已发布；使用者须更新客户端。

## 结论与文档验收

官方模型与 Android 选项闭环、真实 start/steer 连续发送、客户端构建和回归、模拟器后台服务及通知验收均已通过。服务端 30 分钟持续同步结果见下表。**本轮本地验收不代表生产发布。** 用户确认暂时没有真机，物理设备验证保留为明确限制；模拟器结果不替代厂商 ROM 和硬件声音验证。

架构、协议、前端设计、spec.json 和 review.md 已同步。设计渲染包含 13 个页面、29 个动作、57 张图；结构、链接、图片、来源哈希和页面边界检查无问题。`scripts/check-design-contract.mjs` 对照 TypeBox 字段和枚举，Markdown 检查覆盖 12 份文档。`source-baseline.json` 记录实现验收基线，不代表开发前的用户确认。

## 已解决的问题

- 普通消息直接提交对应会话；仅串行化同一会话的短 RPC 提交，运行中调用官方 steer，不等待上一个回合结束，不增加本地审批。
- 保留官方全部问题，一次提交完整答案；支持单选、文本、秘密文本、补充选项、审批确认，以及受支持 MCP 表单的多选和布尔字段。
- Windows 和 Android 共用工作站请求入口；服务端核对 requestId、threadId 和控制器，首个提交生效，重复提交回放终态。离线、未知请求、失效、无效答案及重连恢复都有明确处理。
- 修复双向 JSON-RPC 数字 ID 相撞导致客户端请求被错误完成、首条 started 后路由丢失、回合失败误判完成、旧交互复活和旧消息回执清空新草稿。
- 三端统一进行中、已完成、失败、待确认；筛选顺序同上，无有效运行证据归入待确认。状态证据时效与来源时间独立处理。
- Android 设置拆分连接摘要、设备偏好和二级页面，限制宽度、提高点击目标、支持即时主题与连接修改丢弃确认。交互表单模块独立，秘密答案只在内存中保存。修复系统栏与主题不同步、安全区背景及浅色系统栏白色图标对比度问题。
- 后续修复前台服务计数、系统超时停止/恢复和假连接状态、关闭握手、锁屏脱敏通知、慢订阅者静默丢广播、长中文消息字节限制、Windows 更新误报、无 Monitor 时无法退出及关闭期间 outbox 并发写入。
- 删除过时 Windows renderer、旧状态映射和连接 URL 兼容行为。升级 Electron 和 ws；依赖审计无已知漏洞。

## 可重复验证与证据

本地证据根目录：`artifacts/acceptance-2026-09-10/`。日志、安装包、临时诊断和真实截图不提交仓库；仓库保留验收脚本与结论。

| 验证项 | 结果 | 证据及边界 |
|---|---|---|
| TypeScript 三工作区构建 | 通过 | 协议、服务端、Windows |
| Node 回归 | 12 文件 / 43 项通过 | tests-followup.log；包含 RPC ID 相撞、官方表单转换、状态、消息/交互路由、幂等及旧协议拒绝 |
| Android 单元、lint、Debug 构建 | 9 项通过；lint 无错误 | android-followup.log；工具链与依赖升级建议仍有警告 |
| Android Release 与签名 | 通过 | android-release.log；APK 签名验证通过，APK 签名 v2 与业务协议 v3 是不同概念 |
| Windows NSIS 打包 | 通过 | windows-package-followup.log；尚无 Authenticode 签名 |
| Electron 实际渲染与 preload | 通过 | electron-smoke.json；设置、交互、深色、托盘图标正常，无捕获错误；IPC 使用合成数据 |
| Android 手机界面与选项回传 | 通过 | android-roundtrip.json；模拟器经真实 Fastify/WebSocket 服务提交 MCP 多选与文本，官方适配器验证通过，终态表单消失 |
| Android 设置、主题、返回与适配 | 通过 | android-ui-report.json；手机/1600×1200 平板、深浅色与系统栏对比度、键盘返回、继续编辑/丢弃、200% 字号滚动与关于页；仅模拟器 |
| 性能微基准 | 通过 | perf-v3.log；1000 事件总计 3640ms，P50 2ms、P95 9ms、快照 43ms、RSS 161406976 字节；仅本地短时测试 |
| Android 1000 任务快照与搜索 | 通过 | android-thousand-tasks.json；保存连接、加载大快照、导航和搜索第 999 个任务成功；6.02 秒包含自动化与导航开销，不是纯渲染基准 |
| 服务端 30 分钟持续同步 | 通过 | server-endurance.json；4450 事件、1000 任务、5 次重连/7 次快照，最终游标匹配；预热后 RSS 105.0–114.1 MiB，末次累计 CPU 0.93% 单核，末分钟入站 P95 12.4ms；含 Android 大快照接入，非全链路长期基准 |
| npm 依赖审计 | 0 漏洞 | npm audit；不能推断全部产品逻辑安全 |
| 官方 app-server 初始化 | 通过 | 安装的 codex-cli 0.153.4 可初始化及读取列表；不保存个人会话标识 |
| 官方模型选项闭环 | 通过 | official-smoke.json；实际 gpt-6-astra 提出选项、收到回复并完成回合，约 19 秒 |
| 官方模型 → 服务端 → Android → 官方回合 | 通过 | official-android.json；手机实际点击 Alpha 并提交，官方回合继续完成；使用真实 app-server、协议适配器和 Fastify/WebSocket，Monitor 路由另有回归覆盖 |
| 官方 start/steer 连续发送 | 通过 | official-steer.json；一个 turn/start 后连续两个 steer 均接受并关联同一 turn，最终完成 |
| Android 前台服务超时与恢复 | 通过 | android-background.json；API 36 模拟器、target 35，系统 dataSync 时限缩短为 10 秒触发真实超时；服务主动停止，回到已有 Activity 后恢复并连接；测试设置已恢复 |
| Android 后台通知与服务端关闭 | 通过 | 后台从 running→completed 正确通知，常驻计数 1→0，锁屏 publicVersion 不含任务正文；1013 关闭后重连且恢复待答表单 |

官方 schema 来源为本机 CLI 导出的 JSON schema，并核对 [官方 app-server 文档](https://developers.openai.com/codex/app-server/)。真实模型测试使用独立临时目录与 ephemeral 线程、合成 Alpha/Beta 选项，未操作已有用户会话。验收脚本改用 thread/start 返回的实际模型、低推理强度并记录脱敏诊断后通过；此前超时的唯一原因未被证明，不将选错默认模型声明为已证实的唯一根因。

## 明确保留的限制与发布门

1. 官方模型闭环阻塞项已关闭。官方用户问题在真实模型与 Android 上验收；MCP 多选、审批确认、取消和异常结构使用官方 schema 夹具、协议适配器及路由回归验证，不声称每个官方模型都现场生成过每种 RPC。
2. 独立 app-server 只拥有自己进程发出的请求，不能处理另一个官方 Codex Desktop 进程的审批。移动端不是对所有桌面私有 UI 能力的复刻。
3. 官方没有独立 plan_select RPC；计划问题走普通问题表单。MCP 数字、格式、嵌套、URL 表单明确显示 unsupported 并允许取消，不伪造成功。
4. 中转只允许一个工作站控制器。终态缓存最多 1000 条，进程重启后未知提交返回 expired。无官方过期时间时不编造截止时间。
5. 用户明确选择“暂时没有真机，保留明确限制”。物理手机、国产 ROM、锁屏保活、通知声音、电池策略和屏幕阅读器完整操作未验证；系统前台服务时间限制已在模拟器实测，不能等同真实六小时耗尽或所有厂商行为。
6. 服务端持续负载见上表；它不代表 Windows/Android/模型全链路长期资源测试。快照能恢复超过 500 条变化后的当前状态，但中间历史仍只重放最多 500 条，不承诺保存所有中间事件。慢订阅者现以 1013 关闭并重连，回归和 Android 实测通过。WebSocket 入站提高为 128KiB，20000 中文字符回归通过。损坏 outbox 停止并保留文件，不自动恢复或重置设备序号；需要有效备份。
7. 桌面/Android 全量 OpenTelemetry、trace 树排序与桌面日志轮转属于现有能力边界，见 Trace 文档；部署回滚边界见运维文档。Windows 版本比较已改为 semver，仅提示更高有效版本。
8. 后端及两端安装包已发布，但Android 真机覆盖安装及生产真实交互回合闭环未验收；用户日常 Windows 已完成下述本地状态恢复和生产采集同步验证。Windows 安装包未签名。部署成功路径已实测，故障自动恢复经过脚本检查，未在生产主动制造故障演练；不能把备份存在等同回滚演练通过。

本轮模拟器曾发生系统 UI 无响应及 UI 自动化服务启动超时；恢复后完成上述最终检查。这些环境故障未计作功能通过，也未据此认定应用崩溃。测试仅控制专用 emulator-5580，未操作其他模拟器。

生产部署和下载发布已完成；真机限制按用户确认保留。部署与下载证据见下节。

## 2026-09-10 生产发布记录

用户明确授权直接部署、发布安装包并提交本地 Git。本轮未推送远程仓库。

- 生产 release：`20260910114414-a577603b9635`；systemd 服务 active，当前链接指向该 release。
- 协议：`codex-assistant.v3`；SQLite `user_version=6`。旧 schema 5 数据库停机后备份到 `/var/backups/codex-assistant/20260910114414-a577603b9635`，未迁移旧数据。初始任务快照为空；新版工作站接入后重新采集上传。
- 公网 HTTPS 检查：health 正常；v3 未认证任务接口 401、认证读取 200；旧 v2 任务接口 404；WSS 完成认证、订阅和快照接收。该检查未生成合成生产任务，不冒充用户设备实际会话验收。
- 已原子发布两个版本化安装包和 UTF-8 无 BOM 联合清单；旧清单保存在同一恢复目录的 `download-manifest.json`。Windows 包未签名，Android 沿用 release 签名并验证通过。
- 公网完整下载校验：两个安装包经 HTTPS 分段下载并按顺序合并，字节数及整文件 SHA-256 均与联合清单一致；manifest 返回 `no-store`，版本化文件返回一年 `immutable` 缓存。初始单连接 Windows 下载超时，分段完整校验最终通过，不能把超时的部分文件作为证据。
- 本地证据：`artifacts/production-2026-09-10/live-verification.json`、`publication.json`、`download-verification.json`、`tests-final.log`；部署日志位于 `artifacts/acceptance-2026-09-10/deployment-final.log`。

| 平台 | 发布版本 | 字节数 | SHA-256 |
|---|---|---|---|
| Windows | 2.0.12 | 111697766 | a70e8c17dc4d244dfdec3f746d8764a8b76f5170ae91321af16affe00471b621 |
| Android | 2.0.10 / code 13 | 2171847 | 8e7f812ab2b4ca1e9595c4cdddd277518b15de5b5bf5a630a03a782b7f3bfc79 |

## Windows 升级后 OUTBOX_INVALID 修复（2026-09-10）

用户安装新版后反馈离线，保存连接报 `OUTBOX_INVALID`。脱敏诊断确认旧队列 JSON 完整、deviceId 与连接一致，但剩余 2 条事件仍为 `codex-assistant.v2`，包含旧状态 idle；v3 严格校验按设计拒绝。发布流程此前遗漏了客户端本地队列的破坏性协议升级步骤。

按运维文档退出应用，将有效连接配置和整个旧 state 保存到本机独立恢复目录；保持地址和加密 Token 不变，生成新 deviceId，再以全新队列启动已安装的 Windows 2.0.12。没有转换旧事件、重用旧序号或修改 Codex 会话文件。

恢复后实测：新队列与连接 deviceId 一致，nextSequence=171、待上传 0 条、170 个任务指纹；生产 health 为 v3/ok，任务数 170、事件数 170、cursor=170、订阅数 1。Windows 到生产服务的实际采集和上传链路恢复。本次没有修改应用二进制或协议，安装包版本保持不变；本机备份和业务内容不提交 Git。

## 手机消息 active writer 修复（2026-09-11）

用户截图确认 Android 发送消息时，工作站返回 `thread ... already has an active writer`。审查发现 Monitor 对每条消息都先调用 `thread/resume`，即使自身已缓存同一线程的 inProgress turn；该行为与 Codex app-server 的单写入者约束冲突。

修复后的顺序是：当前工作站缓存 turn 为 inProgress 时只调用 `turn/steer`；无活动 turn 才调用 `thread/resume`，resume 后若返回活动 turn 则 steer，否则 start。每线程仍只串行短暂 RPC，不等待回合结束，也没有增加本地业务消息队列。`already has an active writer` 统一映射为脱敏归属提示，禁止重试、接管或新建 turn；服务端仍使用 requestId + threadId 关联回执，协议字段未变。

Android 发送草稿不再以本地 WebSocket 写入成功为清空条件，仅在相同 requestId 收到工作站 `started` 回执后清空。工作站拒绝、归属冲突、断线和未知结果均保留草稿。Node 回归新增 direct-steer 和 active-writer 两个场景，最终为 12 文件 / 45 项通过；Android debug 单元测试、assembleDebug 和 lintDebug 通过。物理 Android 设备限制仍按用户确认保留。

## 2026-09-11 客户端发布记录

用户已授权发布、部署与本地提交。本次仅更新 Windows 与 Android 客户端；服务端协议仍为 `codex-assistant.v3`，SQLite schema 仍为 `6`，因此线上服务保留已验证的 `20260910114414-a577603b9635` release。发布没有推送 Git 远程仓库。

- Windows 2.0.13 已从本机已安装且版本匹配的 Electron 44.3.0 打包为 NSIS 安装包。该包为未签名状态（`NotSigned`），没有声称 Authenticode 信任。
- Android 2.0.11（versionCode 14）已用仓库外 release keystore 构建；`apksigner verify --verbose` 通过，签名方案为 v2，单一签名者。
- 两个版本化文件先上传到服务器临时目录并逐个比对 SHA-256；目标同名文件若存在不同字节会拒绝覆盖。验证后以原子 rename 替换 UTF-8 无 BOM 联合清单，旧清单备份到 `/var/backups/codex-assistant/20260911-mobile-writer-fix/download-manifest.json`。
- 公网 HTTPS 验收：`/codex-assistant/health` 返回 `ok` 和 `codex-assistant.v3`；联合清单返回 `Cache-Control: no-store`，两个版本化安装包返回 `Cache-Control: public, max-age=31536000, immutable`。两个文件均完整下载后重新计算 SHA-256，与清单一致。

| 平台 | 发布版本 | 字节数 | SHA-256 |
|---|---|---:|---|
| Windows | 2.0.13 | 111697889 | `79ec01ab0cf9537f7bae7865c2d6358f63a2c2b5c596d7780e1c6d12f58fe3bf` |
| Android | 2.0.11 / code 14 | 2171843 | `f3ecedeaf9addb76524fee255fbf39880ca27a8cff8c97508709f679a79c40a2` |

本地发布证据位于 `artifacts/production-2026-09-11/`，包括联合清单和平台构建输出；二进制包与签名材料不提交 Git。物理 Android 设备的锁屏、通知声音、厂商保活和覆盖安装限制仍按用户确认保留。
