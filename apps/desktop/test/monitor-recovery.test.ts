import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { Monitor } from "../src/monitor.js";

const state = vi.hoisted(() => ({ starts: 0, fail: false }));
vi.mock("../src/app-server.js", () => ({
  CodexAppServer: class {
    get ready() {
      return !state.fail;
    }
    async start() {
      state.starts++;
      if (state.fail) throw new Error("SYNTHETIC_START_FAILURE");
    }
    async stop() {}
    setTraceContext() {}
    async listThreads() {
      return [];
    }
  },
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("uploads startup failures and retries initialization without restarting the application", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const directory = await mkdtemp(join(tmpdir(), "codex-recovery-"));
  state.starts = 0;
  state.fail = true;
  const statuses: string[] = [];
  const uploads: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      uploads.push(body);
      return {
        ok: true,
        json: async () => ({ accepted: true, count: body.spans.length }),
      };
    }),
  );
  const monitor = await Monitor.create({
    stateDirectory: directory,
    apiUrl: "https://synthetic.invalid",
    token: "synthetic-token",
    deviceId: "synthetic",
    onTasks() {},
    onStatus: (value) => statuses.push(value),
  });
  try {
    await monitor.start();
    await vi.waitFor(() => expect(uploads.length).toBeGreaterThan(0));
    expect(
      uploads[0].spans.some((span: any) => span.name === "desktop.poll.error"),
    ).toBe(true);
    expect(statuses.at(-1)).toBe("offline");
    state.fail = false;
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(statuses.at(-1)).toBe("connected"));
    expect(state.starts).toBe(2);
  } finally {
    await monitor.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

it("retains trace spans after a malformed successful response instead of silently acknowledging them", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const directory = await mkdtemp(join(tmpdir(), "codex-trace-receipt-"));
  state.fail = false;
  const uploads: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      uploads.push(JSON.parse(String(init.body)));
      return { ok: true, json: async () => ({ accepted: true, count: 0 }) };
    }),
  );
  const monitor = await Monitor.create({
    stateDirectory: directory,
    apiUrl: "https://synthetic.invalid",
    token: "synthetic-token",
    deviceId: "synthetic",
    onTasks() {},
  });
  try {
    await monitor.start();
    await vi.waitFor(() => expect(uploads).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(uploads).toHaveLength(2));
    expect(
      uploads[1].spans.some(
        (span: any) => span.spanId === uploads[0].spans[0].spanId,
      ),
    ).toBe(true);
    expect(
      uploads[1].spans.some(
        (span: any) => span.attributes?.error === "TRACE_RECEIPT_INVALID",
      ),
    ).toBe(true);
  } finally {
    await monitor.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
