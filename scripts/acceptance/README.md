# 本地验收脚本

从仓库根目录运行。测试使用临时目录和合成数据，不部署或发布。desktop-message 是明确例外：它将手动输入的验收消息发送到指定现有 Desktop 会话，必须使用用户授权的验收目标。新消息验收和 Electron 报告输出到 `artifacts/acceptance-2026-09-13/`；历史脚本仍使用各自原有目录。

## 自动化

```powershell
npm run build
npm test
npm run check:docs
node scripts/check-design-contract.mjs
python docs/frontend-design/render.py
python docs/frontend-design/validate.py
node_modules\.bin\electron.cmd scripts/acceptance/electron-smoke.cjs
node --import tsx scripts/acceptance/official-smoke.ts
node --import tsx scripts/acceptance/desktop-message.ts <threadId>
node --import tsx scripts/acceptance/server-endurance.ts
```

官方测试需要本机 Codex 已具备模型访问能力。模型以 `thread/start` 的实际返回值为准，不能从模型列表猜测当前提供商的可用默认模型。`official-smoke` 使用 plan 模式、低推理强度和 ephemeral 线程，等待真实用户选项请求并回复合成答案；`desktop-message` 启动本机隔离验收中转，由实际 Android 发消息到指定 Desktop 会话；该脚本不创建新会话。诊断仅记录事件类型、耗时和错误类别，不保存账号凭据及现有会话内容。

`server-endurance` 先通过真实 HTTP 写入 1000 个不同任务，再持续 30 分钟更新，通过真实 WebSocket 收集快照和事件，每 5 分钟重连。每分钟写入阶段报告；只有 `completed=true`、最终游标和任务数匹配才算完成。首个近零时间样本不用于稳定 CPU 结论。测试仅代表本地服务与客户端协议负载，不能外推成所有端、模型或真机的长期测试。

## Android 实际界面

`official-android.ts` 和 `ui-server.ts` 均监听回环端口 33241，不能同时运行。只在专用验收模拟器上操作，勿修改其他设备。

1. 安装最新 Debug APK，通过 ADB reverse 将模拟器的 33241 端口映射到本机。
2. 在应用保存地址 `http://127.0.0.1:33241`，Token 为脚本中的 `synthetic-acceptance-token`。
3. 运行 `official-android.ts`，向 `/acceptance/start` POST JSON `{}`；打开“官方 Codex 选项验收”，等待 Alpha/Beta，选择 Alpha 并提交。以 `official-android.json` 的请求、手机答案、官方回复、回合完成四项为准。该脚本通过实际官方客户端与协议适配器接入中转；Monitor 自身另由回归覆盖。
4. 停止官方脚本，再运行 `ui-server.ts`，可验证 MCP 多选与文本。`/acceptance/state` 接受 JSON `{"status":"running"}`（或其余三种合法状态），用于合成后台通知；`/acceptance/disconnect` 接受 JSON `{}`，以 1013 主动关闭手机连接，检查自动重连与待答表单恢复。
5. Android 35+ 系统超时验证只在专用模拟器暂时设置 `activity_manager/data_sync_fgs_timeout_duration=10000`。重新启动测试应用服务后回到桌面，观察真实超时停止；删除该设置，再回到原 Activity，检查服务恢复。测试完成必须恢复设置。

实际界面自动化使用 uiautomator2 的可访问性文本定位；脚本辅助依赖安装在隔离的验收目录，不属于产品依赖。`set_text` 后键盘不一定打开，应先检查当前界面，再决定返回键操作。截图应等待目标页面出现及动画结束，不能把前一页误当验收截图。

物理设备、厂商电池策略、真实声音和屏幕阅读器完整操作不由模拟器通过结果替代。当前用户明确接受暂时没有真机，保留这些限制。
