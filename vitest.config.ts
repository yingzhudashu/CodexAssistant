import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/**/test/*.test.ts", "apps/**/test/*.acceptance.ts"],
    // 真实计时与 SQLite/WS 测试共享主机；限制工作进程，避免并发编译争抢资源造成假超时。
    maxWorkers: 2,
  },
});
