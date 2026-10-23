# 项目上下文

CodexAssistant 是单工作站、共享 Token 的 Windows Electron → Fastify/SQLite → Android Compose 工具。项目入口为 README.md，设计与维护文档索引为 docs/README.md；当前任务与授权边界只记录在 TASK.md。

- 工作区使用 npm workspaces，Node ≥22.19；Android 使用 JDK17、SDK35、Gradle Wrapper。
- 唯一线协议 codex-assistant.v3，SQLite schema=6；不保留旧协议兼容层，不进行 migration，不重置历史用户数据。
- 官方 app-server 用于读取与其自身交互，Desktop 本机工具管道用于消息。真实消息会写用户会话，必须有具体授权；默认验收使用合成接口。
- 先运行 npm run build、npm test，再按 docs/acceptance.zh-CN.md 选择 UI、Android、性能与耐久验收；测试和构建不代表生产上线。
- 前端规格源是 docs/frontend-design/spec.json；通过 render.py 生成 Markdown/HTML/SVG，不只编辑生成文件。
- 凭据、用户日志、数据库、构建产物和原始测试记录不进入 Git。发布与部署需要具体授权，操作参数不得硬编码私人坐标。
