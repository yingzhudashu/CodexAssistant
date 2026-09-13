# Desktop 会话消息发送合同（2026-09-13）

本修订取代独立 app-server 的 resume/steer 发送方案。读取到其他进程的 turn 不代表取得写入权；此前仅验证自有 app-server 的测试不能证明 Desktop 会话可发送。

## 数据流与责任

Android → 已认证 WebSocket → 服务端唯一工作站控制器 → Monitor → Codex Desktop 本机 app-tools 管道 → 目标 threadId。Windows 本机发送从同一 Monitor 入口进入。独立 app-server 仅用于读取、状态采集及它自己收到的交互请求，不再创建、恢复或 steer 消息回合。运行中如何排队/steer 由 Desktop 处理，不创建应用业务队列或审批。

本机证据为 Codex Desktop 26.908.4834.0 随附 codex-app-tools/server.mjs 及实测 tools/list。它是随 Desktop 分发的本机接口，非公开稳定 API；上线验收必须验证实际 Desktop 版本。官方文档网页本次返回 403，不能作为已核实来源。

## 本机协议

枚举当前 Windows 用户可访问的 codex-browser-use-* 命名管道，以 tools/list 检查 namespace=codex_app、name=send_message_to_thread。不依赖枚举顺序：只有一个匹配者才能发送；多个匹配者明确报错，避免发给错误实例。无匹配者显示“工作站 Codex Desktop 未连接，请打开并保持 Codex Desktop 运行后重试”。不增加管道配置项。

帧为 4 字节小端长度加 UTF-8 JSON-RPC 2.0；单帧最多 8 MiB。连接和只读发现请求各最多 2 秒；消息调用最多 10 秒。并发请求共享连接 Promise，以数值 RPC id 关联回复，处理分片、连续帧、无效 JSON、超长响应、断开与关闭。发现完成后关闭非选中连接；停止 Monitor 关闭全部连接。

tools/call 参数为 namespace、tool、arguments、callId、threadId、turnId。arguments 仅传目标 threadId 和 prompt；正文去首尾空白且最多 20000 UTF-16 代码单元。上下文 threadId 使用目标会话，callId 为随机标识；turnId 只作调用上下文标识，不能当作实际回合 ID。此字段与官方插件在缺少执行回合元数据时使用合成标识的行为一致。响应必须为 success=true 且具有合法 contentItems 才能确认接受；success=false 显示固定拒绝文案，不透传原始内容。

超时、断线或坏响应可能发生在消息已经写入之后，显示“结果尚未确认，请读取回合摘要核实。消息不会自动重发。”。立即丢弃旧连接，绝不重放该次写入；下一次用户主动发送重新发现。任何错误都不泄漏管道、内部路径、原始错误或正文。

## 回执与界面

线上仍为 codex-assistant.v3 / SQLite schema 6。result 字段固定 type、protocolVersion、requestId、threadId、status，可选 error；status 只有 started（Desktop 已接受）与 failed（未获得成功确认）。删除消息回执的 streaming/completed 与 text 字段。任务本身的 completed 和 latestTurn 不变，三端须同步升级，不提供兼容映射。

started 是本次发送请求的终态，不能说明任务已开始或已完成。服务端收到回执立即释放路由；Android 清除本次 sending、清空本次未更改的草稿、恢复发送按钮，显示“Codex Desktop 已接受消息，可继续发送；进展请查看回合摘要”。Windows 相同。提交期间禁止重复点击；失败保留草稿；用户在提交期间编辑的新草稿不能被旧回执清除。页面退出和断线均不自动重发写入。

Desktop 通道没有承诺返回实际 turnId 或回合事件流，因此不能用独立 app-server 的同线程通知关联本次消息，也不能以超时伪造回合失败。会话状态和回合摘要沿独立读取链路更新。Android 120 秒未获回执只结束本次等待并提示结果不确定。服务端断开仅使仍未确认的请求失败，不能覆盖已经 started 的回执。

Windows workstation.status.ready 仍表示采集器 app-server 就绪，不代表 Desktop 发送通道可用；每次发送均检查通道，错误就地显示。Desktop 自己拥有的选项/审批仍需在 Desktop 回答，本次发送通道没有提供审批所有权转移能力。

## 验收门

必须覆盖：真实 Desktop 活动会话的消息接收；连续发送；无宿主与多个宿主；工具拒绝；分片/多帧/无效帧；并发连接与关闭；丢回执后无自动重发；独立 app-server 通知不得生成虚假回执；started 后手机可再次发送且断线不覆盖成功；两端失败与编辑中草稿保留。没有安卓真机，厂商保活、硬件通知声音和真实移动网络切换保留限制。
