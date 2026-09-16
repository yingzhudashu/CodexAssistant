# 隔离验收脚本

本地命令在仓库根目录执行。合成测试使用临时 SQLite、占位 Token 和专用 emulator-5580；不连接生产、不操作其他手机。生产只读检查单独列在下方，不进入默认测试命令。原始报告统一写 artifacts/acceptance（网络脚本使用 artifacts/network-recovery），不提交历史过程文件。

## 自动质量检查

```powershell
npm run build
npm test
npm run check:format
npm run check:docs
npm run check:design
python docs/frontend-design/render.py
python docs/frontend-design/validate.py
npm run test:ui
npm run perf:server
npm run test:endurance
```

Electron真实renderer使用合成IPC验证，不向真实Desktop写消息。持续同步30分钟使用真实HTTP/WS、1000个任务、每5分钟重连，只有completed=true且游标/任务数匹配及RSS增长门槛通过才算完成；不是完整历史内容一致性或生产SLA验证。

设计静态检查仅需Python标准库；可选 `validate.py --visual` 需要Playwright、Pillow和本机Edge，执行所有SVG越界/HTML图片及锚点检查，报告输出到 artifacts/acceptance/design，禁止写回设计源目录。

## Android模拟器

先构建Debug APK。启动独立AVD并确认序列号emulator-5580；所有ADB命令必须带 `-s emulator-5580`。端口33241供ui-server、network-recovery-server、official-android互斥使用。

```powershell
python -m venv "$env:TEMP\codexassistant-acceptance-venv"
& "$env:TEMP\codexassistant-acceptance-venv\Scripts\python.exe" -m pip install -r scripts/acceptance/requirements.txt
node --import tsx scripts/acceptance/ui-server.ts
```

另开终端安装Debug APK，执行 `adb -s emulator-5580 reverse tcp:33241 tcp:33241`，配置根地址 `http://127.0.0.1:33241` 与 Token `synthetic-acceptance-token`，进入“移动端验收任务”，运行虚拟环境Python的 `scripts/acceptance/android-smoke.py`。它提交合成多选/文本、读详情、发合成消息并验证草稿和主题；ui-server不调用真实Codex。

停止ui-server后启动 `node --import tsx scripts/acceptance/network-recovery-server.ts`，打开应用再运行 `android-network-recovery.py`。脚本检查20次前后台新快照、3次断网恢复、服务端关闭恢复和writes不增长。恢复原先启用的网络接口，finally恢复测试前设置；没有连接Wi-Fi的AVD不能靠只启用Wi-Fi恢复蜂窝网络。

`android-ui.py` 提供dump/tap/fill/screenshot/back，用可访问性树定位。测试后关闭本轮启动的模拟器和本地服务器。物理设备、OEM电池策略、读屏、真实锁屏声音仍需独立验收。

## 真实Codex边界

`official-smoke.ts` 会创建临时官方线程并驱动选项交互；`official-android.ts` 会通过官方线程完成手机回答；`desktop-message.ts <threadId>` 会向指定现有Desktop会话发送消息。这些脚本可能调用模型或写真实会话，**默认质量命令不执行**，必须先明确授权验收目标。只读启动/list/Goal验证不等于真实消息发送验证。本轮没有向真实会话发消息。

## 生产部署后只读检查

完成目标服务器部署后，将 `production-readonly.mjs` 复制到该服务器临时目录，再使用 `/opt/node-v22.23.2-linux-x64/bin/node` 执行。执行用户需能读取 `/etc/codex-assistant/codex-assistant.env`；脚本复用当前 release 的 ws 依赖。执行结束删除本次上传的脚本。

检查范围包括公网 health、未授权请求401、授权任务快照、WSS鉴权/订阅/释放、HTTP Trace父节点及非法查询422。脚本不发送业务事件或控制消息，凭据不离开服务器；诊断请求仍会产生正常Trace记录。输出仅为布尔结果与数量，不包含真实任务正文或标识。为可靠比较HTTP/WS计数和业务事件数，选择业务上传空闲窗口；并发业务变更可能使一致性断言失败，需核实原因，不能自动重置数据。
