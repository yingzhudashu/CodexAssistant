import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { expect, it, vi } from "vitest";
import { createApp } from "../../server/src/app.js";
import { Monitor } from "../src/monitor.js";

// 仅替代官方进程与发送宿主；outbox、HTTP、SQLite、Trace及双向WS均使用真实实现。
vi.mock("../src/app-server.js", () => ({
  CodexAppServer: class {
    get ready() {
      return true;
    }
    async start() {}
    async stop() {}
    setTraceContext() {}
    async listThreads() {
      return [
        {
          id: "synthetic-e2e",
          name: "合成全链路",
          status: { type: "active" },
          updatedAt: "2026-10-23T00:00:00.000Z",
        },
      ];
    }
    async readThread() {
      return {};
    }
    async getGoal() {
      return undefined;
    }
    async listTurns() {
      return {
        data: [
          {
            id: "synthetic-turn",
            status: "completed",
            items: [{ type: "agentMessage", text: "合成摘要" }],
          },
        ],
      };
    }
    async listItems() {
      return { data: [] };
    }
    latestTurn() {}
    planFor() {}
    planRevision() {
      return 0;
    }
  },
}));

it("round-trips collection, persistence, phone snapshot, detail, send receipt and trace over real local transports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-e2e-"));
  const token = "synthetic-e2e-access-token";
  const server = await createApp({
    databasePath: join(directory, "state.sqlite"),
    accessToken: token,
    logger: false,
  });
  let monitor: Monitor | undefined;
  let phone: WebSocket | undefined;
  try {
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const address = server.app.server.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    const sendMessage = vi.fn(async () => {});
    let controlReady = false;
    monitor = await Monitor.create({
      stateDirectory: directory,
      apiUrl: base,
      token,
      deviceId: "synthetic-e2e-device",
      onTasks() {},
      onControlStatus: (ready) => {
        controlReady = ready;
      },
      desktopHost: { sendMessage },
    });
    await monitor.start();
    await vi.waitFor(() => expect(controlReady).toBe(true), { timeout: 5000 });
    const messages: any[] = [];
    phone = new WebSocket(
      `${base.replace("http:", "ws:")}/codex-assistant/api/v3/stream`,
    );
    phone.on("message", (raw) => messages.push(JSON.parse(String(raw))));
    await new Promise<void>((resolve, reject) => {
      phone!.once("open", resolve);
      phone!.once("error", reject);
    });
    phone.send(
      JSON.stringify({
        type: "auth",
        protocolVersion: "codex-assistant.v3",
        token,
      }),
    );
    await vi.waitFor(() =>
      expect(messages.some((value) => value.type === "authenticated")).toBe(
        true,
      ),
    );
    phone.send(
      JSON.stringify({
        type: "subscribe",
        protocolVersion: "codex-assistant.v3",
        after: 0,
      }),
    );
    await vi.waitFor(() =>
      expect(
        messages.find((value) => value.type === "snapshot")?.tasks[0],
      ).toMatchObject({ id: "synthetic-e2e", status: "running" }),
    );
    phone.send(
      JSON.stringify({
        type: "detail",
        protocolVersion: "codex-assistant.v3",
        requestId: "synthetic-detail",
        threadId: "synthetic-e2e",
      }),
    );
    await vi.waitFor(() =>
      expect(
        messages.find((value) => value.requestId === "synthetic-detail")?.type,
      ).toBe("detail"),
    );
    phone.send(
      JSON.stringify({
        type: "send",
        protocolVersion: "codex-assistant.v3",
        requestId: "synthetic-send",
        threadId: "synthetic-e2e",
        text: "synthetic private message",
      }),
    );
    await vi.waitFor(() =>
      expect(
        messages.find((value) => value.requestId === "synthetic-send")?.status,
      ).toBe("started"),
    );
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(
      "synthetic-e2e",
      "synthetic private message",
    );
    const outbox = JSON.parse(
      await readFile(join(directory, "outbox.json"), "utf8"),
    );
    expect(outbox.events).toHaveLength(0);
    expect(outbox.nextSequence).toBe(2);
    const event = messages.find((value) => value.type === "event").event;
    const response = await server.app.inject({
      url: `/codex-assistant/api/v3/traces/${event.trace.traceId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(
      response.json().spans.map((span: { name: string }) => span.name),
    ).toEqual(
      expect.arrayContaining([
        "desktop.event",
        "desktop.poll",
        "server.ingest",
        "http.post",
      ]),
    );
    expect(response.body).not.toContain("synthetic private message");
    expect(
      await readFile(join(directory, "outbox.json.trace.jsonl"), "utf8"),
    ).not.toContain(token);
  } finally {
    phone?.terminate();
    await monitor?.stop();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
