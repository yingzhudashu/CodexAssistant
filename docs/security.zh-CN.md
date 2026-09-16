# 安全边界

## 凭据和传输

Windows Token 用 Electron safeStorage 加密；Android 用 Keystore AES-GCM。保存的 Token 不由 connection.get 回填 renderer；输入框仍会暂时持有用户本次输入。Token 长度 16–4096，客户端只接受 HTTPS 根地址或回环 HTTP，拒绝 userinfo、API 子路径、query 和 fragment。Android Release 禁用明文，Debug 默认 127.0.0.1，模拟器用 adb reverse。

服务器默认回环监听，生产由 Nginx 终止 TLS。任务、Trace 与 WebSocket 必须认证；health 公开资源计数，不含业务正文。共享 Bearer Token 持有者同权，工作站角色不是另一套权限。部署面向单工作站个人使用，不提供多租户隔离。

## 信任边界

Electron 使用 contextIsolation、sandbox、关闭 nodeIntegration；IPC 同时校验当前窗口 webContents 和精确本地页面 URL。禁止窗口导航与 window.open。只通过窄 preload API 调用功能；更新下载仅打开 HTTPS。Markdown 使用禁用 HTML 的解析器，原文不能产生 script；受 CSP 和禁止外部导航共同约束。

服务端严格校验协议对象、字段长度、HTTP/WS 载荷大小；控制响应关联请求所属工作站、requestId、threadId。只有一个在线控制器，重复请求和非法所有权拒绝。动态交互的答案仍由工作站按原始官方 schema 校验。

自动快照只上传脱敏标题、项目名、计划、状态、动作类型、时间和公开 Goal。sanitizeText 移除常见路径、密钥形状、多余空白并截断，不保证识别所有业务秘密。主动消息、主动详情、审批上下文和回答是用户要求传输的内容，不能把“自动同步脱敏”扩展成它们不含正文的承诺。服务端只中转控制正文，不将完整历史存入任务库。

Trace 直接上传、exporter 和桌面本地日志均按同一白名单投影，普通错误文本替换为安全代码。Android 日志不保存正文。诊断数据仍包含关联 ID，分享前需审查。rollout 的文件时间只是可修改的观测证据，不是可信的进程证明。

## 发布和工作区

不提交 Token、私钥、keystore、密码、本地配置、数据库、安装包或过程日志。忽略规则不是凭据审计，提交前检查全部差异。测试用合成标识，不记录真实会话正文、个人身份或路径。

Android 更新需要原 release keystore；Windows 构建默认未签名，不能声称可信发布者。下载由浏览器执行，两端不自动校验下载字节哈希，发布端必须完整下载后比对 SHA-256。

清理脚本仅删除固定的生成路径，验证目录边界并拒绝目录链接；不修改业务状态或仓库外签名材料。旧协议直接拒绝，损坏 outbox 保留现场，不以静默重置掩盖错误。
