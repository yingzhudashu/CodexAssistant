# 设计与实现一致性验收记录

## Android 网络恢复实现验收

详细合同见 [网络恢复设计](../android-network-recovery.zh-CN.md)。代码审查确认前台唤醒缺失、无默认网络回调、无认证/快照超时、旧回调失效保护不足与过早重置退避；用户现场尚未复现，不认定唯一根因。新增规格把任务页、设置和常驻通知的连接展示绑定到同一状态，服务生命周期和网络可用性分开说明。

审查覆盖正常、无网络、网络切换、半开连接、超时、认证/协议拒绝、重复唤醒、旧回调、服务销毁交错、配置更换及未确认写请求；对应处理和可重复验收目标已逐项定义。协议仍为 codex-assistant.v3 / schema 6，无服务端字段变更。渲染与结构结果见 validation.json；它只检验设计，不能替代设备验收。发布候选为 Windows 2.0.13 / Android 2.0.12（versionCode 15）。

实现验收：NetworkRecoveryTest 覆盖握手期限、快照前禁写、旧回调隔离、永久错误不重试和 20 次真实 WebSocket 重认证；专用 API 36 模拟器完成 20 次前后台切换（每次 1.1-1.4 秒）、3 次网络恢复（4.3-4.7 秒，含 Wi-Fi 关联）及服务端主动关闭恢复（1.08 秒）。保留限制：无真机，未验证厂商保活、硬件声音和真实移动网络切换。

文档与实现验收（2026-09-12）：13份 Markdown 链接与版本校验通过；协议枚举/字段契约通过；重新渲染13页、29交互、57图，静态验证0问题。旋转不重复重连、旧服务实例销毁隔离，以及只存在于 Android 内存的 networkAvailable/backgroundSyncStatus 字段均已实现；线上不新增字段。source-baseline.json 更新为本轮审查后的实现基线。

以下为既有版本验收记录，不代表本轮网络恢复已经实现。

本记录替换过时的九状态、单飞发送和未实现交互描述。当前设计对象为 Windows 2.0.13、Android 2.0.12（versionCode 15）；唯一协议 codex-assistant.v3，数据库 schema=6。旧客户端和旧数据库直接拒绝，不建立兼容层或 migration。

已解决：普通消息等待回合结束才可继续发送；官方 questions 被丢弃；审批回复为布尔值；多问题未完整提交；提交无回执；旧交互重新出现；回合失败被当作完成；服务端首条 started 后失去路由；多端重复提交；旧性能夹具与版本说明；Android 设置缺少分区层次、系统栏对比度错误、运维文档残留旧 schema。

字段、状态、请求生命周期以 protocol.zh-CN.md 为唯一规范。spec.json 的 protocolContract 与 TypeBox 通过 scripts/check-design-contract.mjs 逐字段校验；render.py 重建布局、动作图、Markdown 和 HTML；validate.py 检查来源哈希、链接、表格、SVG、图片和边界。

Android 设置分离为 SettingsPage；交互为 InteractionCard。Windows 使用同一个 Monitor 交互入口，服务端只做鉴权、关联和幂等。文档 source-baseline.json 是实现后的验收基线，不能冒充开发前冻结或产品负责人确认记录。结构图表达目标布局，不是假造真机截图。

明确限制：独立 app-server 只拥有本进程请求，不能替其他 Codex 桌面进程处理审批。官方没有独立计划选择事件，计划问题使用普通问题表单；MCP 数值、格式、嵌套、URL 表单超出当前支持范围并显示 unsupported。无官方请求过期时间时不设置虚构截止时间。终态回执缓存最多1000条，重启后未知提交返回 expired。当前中转只接受一个工作站控制器，避免把消息发送给错误工作站。

Android 已完成手机/平板、深浅主题、系统栏、200% 字号、连接修改丢弃和多选文本回传实测；结果记录在 [验收文档](../acceptance.zh-CN.md)。静态文档检查不等同真实模型、物理设备和生产发布验收。

后续验收已跑通官方 app-server 真实选项→Android 提交→官方回合完成；修复前台服务超时与回前台恢复、通知计数和锁屏 publicVersion、慢订阅者重连、长中文消息、Windows 版本比较、队列损坏停止及退出竞态。持续同步与物理设备结果以验收文档为准。

2026-09-11 发送链路复审：截图中的 `already has an active writer` 证明现有“每次发送先 resume”与官方单写入者模型冲突。设计现改为已知本工作站 inProgress 回合直接 steer；仅无活动回合 resume 后 start。另一实例持有写入权时固定显示脱敏归属提示，保留草稿，不自动重试、接管、换 turn 或建立应用队列。前后端协议字段无需变化；验证须覆盖 direct-steer 路径和 active-writer 失败路径，Android 不得显示原始 threadId。
