# CodexAssistant 部署

创建专用 `codexassistant` system user，安装服务端使用的 Node 22，并将干净 release 发布到 `/opt/codex-assistant/releases/<release-id>`，再让 `current` 指向该 release。以 root 创建权限为 `0600` 的 `/etc/codex-assistant/codex-assistant.env`：

```text
CODEX_ASSISTANT_ACCESS_TOKEN=<随机 bearer token>
```

创建并授权 `/var/lib/codex-assistant`，安装 `codex-assistant.service`，然后执行：

```bash
systemctl daemon-reload
systemctl enable --now codex-assistant.service
curl -fsS http://127.0.0.1:3240/codex-assistant/health
systemctl status codex-assistant.service --no-pager
nginx -t
```

公网反向代理必须保留 `/codex-assistant/` 前缀，并将 `/api/v2/stream` 升级为 WebSocket。`codex-assistant-staging.service` 使用端口 `3241`、状态目录 `/var/lib/codex-assistant-staging`、发布目录 `/opt/codex-assistant-staging/current` 和独立环境文件，发布到 `staging.example.com`；生产和 staging 不得复用状态文件或 Token。

当前数据库 schema 为版本 5，包含任务事件、任务快照和 `trace_spans`。已有数据库的版本或表集合不匹配时会硬失败，必须先备份旧 SQLite 文件后清空状态目录再部署，不执行 migration。health 接口返回进程 RSS、事件/任务/span 数量和当前游标。故障排查和回滚规则见 [`../docs/operations.zh-CN.md`](../docs/operations.zh-CN.md)。
