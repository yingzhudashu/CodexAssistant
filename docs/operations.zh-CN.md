# 运维与故障处理

## 配置

服务运行于专用 codexassistant 用户，release 目录 `/opt/codex-assistant/releases/<id>`，current 指向活动 release，状态目录 `/var/lib/codex-assistant`。环境文件 `/etc/codex-assistant/codex-assistant.env` 权限 0600；Token 不写入文档或日志。

|变量|默认值|用途|
|---|---|---|
|CODEX_ASSISTANT_HOST|127.0.0.1|监听地址|
|CODEX_ASSISTANT_PORT|3240|HTTP/WS 共用端口|
|CODEX_ASSISTANT_STATE_DIR|/var/lib/codex-assistant|独立 SQLite 目录；Windows 开发显式覆盖|
|CODEX_ASSISTANT_ACCESS_TOKEN|无|少于 16 字符拒绝启动|

Nginx 保留 /codex-assistant 前缀并升级 stream；配置模板见[部署说明](../deploy/README.md)。staging 用独立端口 3241、目录、域名和 Token。生产 unit 资源限制与开发压力进程不是同一环境。

```bash
systemctl status codex-assistant.service --no-pager
curl -fsS http://127.0.0.1:3240/codex-assistant/health
journalctl -u codex-assistant.service --since '10 minutes ago'
nginx -t
```

health 只证明服务响应；上线还须验证桌面上传、手机 snapshot 和一次明确授权的控制链路。CPU 指标是进程累计微秒，比较相邻采样；RSS 看预热后的趋势。traceFailedExports 增加说明诊断存储故障，不能推断业务事件丢失。

## 定位顺序

|现象|检查与处理|
|---|---|
|手机没有新任务|核对桌面采集、outbox、HTTP 鉴权、服务 tasks/cursor、手机连接状态；桌面 connected 不保证 outbox 已排空|
|Android 离线|区分无默认网络、握手中、重试、认证错误、协议错误及同步服务停止；不要统一重置 Token|
|Android后台通知迟到|先按[当前发布说明](release.zh-CN.md)核对安装版本，再检查通知权限、提醒渠道、电池优化和后台同步状态；按下文Trace区分接收延迟与通知提交延迟|
|GitHub已发行但客户端未提示更新|客户端只读取自己配置的服务器联合清单；GitHub附件和私人服务器清单分别发布。服务器部署也不会替用户安装客户端|
|认证/协议错误|停止无意义重连，编辑有效配置后重新认证|
|工作站未连接|核对唯一 desktop 控制器；这是转发失败，未必是手机网络故障|
|消息超时|先读回合摘要核实。宿主 10 秒、服务路由 30 秒；未知结果不自动重发|
|历史任务看似运行|检查 freshness、官方运行态及 ACTIVE_EVIDENCE_EXPIRED；notLoaded 不是 idle，文件证据也不是进程存活证明|
|OUTBOX_INVALID|退出工作站并保留现场，从同一设备的有效当前格式备份恢复；禁止删队列后沿用旧 deviceId 从序号 1 上传|
|SCHEMA_MISMATCH|停止服务，备份原库与 WAL/SHM，使用新的空状态；没有 migration 或兼容读取|
|频繁 WS 重连|检查证书、反代 upgrade/超时、慢消费者背压与设备网络；完整快照负责恢复当前状态|
|Trace 查不到|核对 ID、客户端待发队列、导出失败与保留窗口；等待最终上传后再查，不以诊断缺段认定业务失败|

## 备份与容量

schema 6 的表为 devices、task_events、tasks、trace_spans。备份时停止服务，作为一个状态集合保存 SQLite、WAL、SHM，再启动；不要复制活动库的部分文件来声称一致备份。恢复前保持版本匹配并备份当前现场。不向旧 schema 写入，也不导入旧协议事件。

Trace 有保留上限；业务事件和任务目前不自动清理，磁盘使用随运行增长。定期观察计数、文件大小和备份空间。SQLite 清理后已分配页可复用，不会自动缩小文件。需要清空业务状态时按明确的数据重置操作处理，不能作为普通性能优化。

Windows userData 中 connection.json 保存加密凭据，state/outbox.json 保存序号/待发事件。两者关联设备身份，应一起备份。诊断 JSONL 可轮转丢弃，业务 outbox 不可随意删除。旧格式直接拒绝；文档不提供迁移脚本。Android 凭据无法解密时清除不可恢复 Token/cursor 并重新配置。

## Android 生命周期

Activity 和前台服务共同拥有一个连接。回前台及默认网络变化主动恢复；无网络暂停拨号，只有 snapshot 确认连接。认证/协议错误要求编辑配置。拒绝通知权限不等于订阅失败，关闭提醒渠道不等于停止同步。

持续实时通知使用声明具体用途的specialUse前台服务，由用户打开应用启动。设置→通知可查看电池优化状态并主动申请后台持续连接。未豁免时息屏网络可能受Doze限制，厂商自启动/后台权限仍需单独设置。亮屏或退出休眠会主动校准连接；用户强行停止应用后需重新打开。

通知延迟先区分事件未收到还是系统通知未更新：对照事件的android.sync.event与android.sync.notification_delivery同trace记录。断线期间变化在快照恢复后补报最新状态；通知发送按300ms间隔合并，避免系统丢弃突发更新。短时CPU锁只覆盖通知队列处理，空闲后释放。厂商锁屏、电池策略、实际声音仍须逐设备验证。

发布和失败回滚见[发布说明](release.zh-CN.md)。`npm run clean` 只清理开发生成物，不能用来恢复生产状态。
