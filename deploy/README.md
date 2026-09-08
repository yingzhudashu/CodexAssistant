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
nginx -t && systemctl reload nginx
```

公网反向代理必须保留 `/codex-assistant/` 前缀，并将 `/api/v2/stream` 升级为 WebSocket。`codex-assistant-staging.service` 使用端口 `3241`、状态目录 `/var/lib/codex-assistant-staging`、发布目录 `/opt/codex-assistant-staging/current` 和独立环境文件，发布到 `staging.robotclaw.site`；生产和 staging 不得复用状态文件或 Token。

当前数据库 schema 为版本 5，包含任务事件、任务快照和 `trace_spans`。已有数据库的版本或表集合不匹配时会硬失败，必须先停止服务、人工备份数据库及 WAL 状态，再准备新的空状态目录；同 schema 发布不清空现有数据，不执行 migration。health 接口返回进程 RSS、事件/任务/span 数量和当前游标。故障排查和回滚规则见 [`../docs/operations.zh-CN.md`](../docs/operations.zh-CN.md)。

## 配置对应关系

- 生产 unit：`codex-assistant.service`，端口 3240，内存硬限制 320M，CPUQuota 25%。
- staging unit：`codex-assistant-staging.service`，端口 3241，内存硬限制 256M，CPUQuota 15%。
- 两个 unit 的 Node 路径均为 `/opt/node-v22.23.2-linux-x64/bin/node`；其他主机部署需调整为真实安装路径。
- `nginx-codex-assistant.locations.conf` 必须包含在已有 HTTPS server 块中；精确 stream location 设置 Upgrade、Connection、3600 秒读超时并关闭代理缓冲。
- 更新清单单独使用 `no-store`，版本化下载文件使用一年 immutable 缓存，因此不能覆盖已发布版本文件。

从 Windows 工作区运行 `scripts/deploy-production.ps1 -Server robotclaw-server` 可发布生产服务；脚本依赖已配置的 SSH 别名、scp、服务器 sudo 权限与现有 `/etc/nginx/sites-available/robotclaw.conf`。它发布服务 release，不负责构建和上传客户端安装包；客户端步骤见 [发布文档](../docs/release.zh-CN.md)。
