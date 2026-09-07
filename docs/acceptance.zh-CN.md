# 当前验收状态

- [x] TypeScript 协议、服务端和桌面端构建通过。
- [x] Node 单元与服务端集成测试通过。
- [x] Android `:app:assembleDebug` 通过。
- [x] 协议已升级为 `codex-assistant.v2`，旧版本直接拒绝。
- [x] 任务状态区分 Goal、线程运行态、active flags、最近 Turn 和数据新鲜度。
- [x] 桌面详情 RPC 失败保留缓存并标记 stale，不再把正常空闲线程伪装为失败。
- [x] Android WebSocket 具备连接中、认证中、同步中、已连接、重连中、离线、认证失败和协议错误状态。
- [x] Android Trace 使用有界队列异步批量上传，上传失败不阻塞 WebSocket 和任务 reducer。
- [x] 桌面端展示连接中、同步中、已连接和离线状态，线程详情失败保留缓存并标记 stale。
- [x] 服务端支持 trace span 批量写入和 v2 trace 查询。
- [x] 服务端性能基准可通过 `npm run perf:server` 执行。
- [x] 构建产物、安装包和 APK 已加入忽略规则，不应提交到版本库。

## 尚未完成的外部验收

- [ ] 真实 Windows Authenticode 签名包发布。
- [ ] 真实 Android 设备后台保活、通知权限和国产 ROM 电池策略验证。
- [ ] 生产环境部署 v2 服务、Nginx 和全量客户端。
- [ ] 30 分钟桌面稳定性、Android 功耗和生产压测记录。

验收时必须覆盖 `active → waiting → paused/blocked → complete/failed` 全链路，并检查日志、trace 和网络 payload 不含 Token、命令输出、绝对路径或对话正文。
