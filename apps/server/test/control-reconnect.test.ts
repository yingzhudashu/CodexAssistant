import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "@codex-assistant/protocol";
import { createApp } from "../src/app.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "codex-control-reconnect-"));
  const server = await createApp({
    databasePath: join(directory, "state.sqlite"),
    accessToken: "control-reconnect-test-token",
    logger: false,
  });
  const peers: WebSocket[] = [];
  await server.app.listen({ host: "127.0.0.1", port: 0 });
  const address = server.app.server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  cleanups.push(async () => {
    peers.forEach((peer) => peer.terminate());
    await server.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function connect(desktop = false) {
    const socket = new WebSocket(
      `ws://127.0.0.1:${address.port}/codex-assistant/api/v3/stream`,
    );
    peers.push(socket);
    const messages: Record<string, any>[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const send = (value: Record<string, unknown>) =>
      socket.send(
        JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...value }),
      );
    send({ type: "auth", token: "control-reconnect-test-token" });
    send({ type: "subscribe", after: 0 });
    await vi.waitFor(() =>
      expect(messages.some((message) => message.type === "snapshot")).toBe(
        true,
      ),
    );
    if (desktop) {
      send({ type: "role", role: "desktop" });
      await vi.waitFor(() =>
        expect(
          messages.some((message) => message.type === "desktop.ready"),
        ).toBe(true),
      );
    }
    return { socket, messages, send };
  }

  return { connect, server };
}

it("keeps a controller alive when its initial snapshot exceeds the live-send threshold", async () => {
  const fixtureServer = await fixture();
  const desktop = await fixtureServer.connect();
  const serverSocket = [...fixtureServer.server.app.websocketServer.clients][0];
  let bufferedAmount = 256 * 1024;
  Object.defineProperty(serverSocket, "bufferedAmount", {
    configurable: true,
    get: () => bufferedAmount,
  });
  desktop.send({ type: "role", role: "desktop" });
  await vi.waitFor(() =>
    expect(
      desktop.messages.some((message) => message.type === "desktop.ready"),
    ).toBe(true),
  );
  expect(serverSocket.readyState).toBe(WebSocket.OPEN);

  const phone = await fixtureServer.connect();
  phone.send({
    type: "send",
    requestId: "large-snapshot-message",
    threadId: "thread-1",
    text: "send after snapshot drains",
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(
    phone.messages.some(
      (message) =>
        message.type === "result" &&
        message.requestId === "large-snapshot-message",
    ),
  ).toBe(false);

  bufferedAmount = 0;
  await vi.waitFor(() =>
    expect(
      desktop.messages.filter(
        (message) =>
          message.type === "send" &&
          message.requestId === "large-snapshot-message",
      ),
    ).toHaveLength(1),
  );
  desktop.send({
    type: "result",
    requestId: "large-snapshot-message",
    threadId: "thread-1",
    status: "started",
  });
  await vi.waitFor(() =>
    expect(
      phone.messages.filter(
        (message) =>
          message.type === "result" &&
          message.requestId === "large-snapshot-message",
      ),
    ).toHaveLength(1),
  );
});

it("waits for workstation reconnect and dispatches a phone request once", async () => {
  const server = await fixture();
  const desktop = await server.connect(true);
  const phone = await server.connect();
  desktop.socket.close();
  await vi.waitFor(() =>
    expect(desktop.socket.readyState).toBe(WebSocket.CLOSED),
  );

  phone.send({
    type: "send",
    requestId: "reconnect-message",
    threadId: "thread-1",
    text: "continue after reconnect",
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(
    phone.messages.some(
      (message) =>
        message.type === "result" && message.requestId === "reconnect-message",
    ),
  ).toBe(false);

  const resumed = await server.connect(true);
  await vi.waitFor(() =>
    expect(
      resumed.messages.filter(
        (message) =>
          message.type === "send" && message.requestId === "reconnect-message",
      ),
    ).toHaveLength(1),
  );
  resumed.send({
    type: "result",
    requestId: "reconnect-message",
    threadId: "thread-1",
    status: "started",
  });
  await vi.waitFor(() =>
    expect(
      phone.messages.filter(
        (message) =>
          message.type === "result" &&
          message.requestId === "reconnect-message",
      ),
    ).toHaveLength(1),
  );
  expect(
    phone.messages.find(
      (message) =>
        message.type === "result" && message.requestId === "reconnect-message",
    )?.status,
  ).toBe("started");
  expect(
    resumed.messages.filter(
      (message) =>
        message.type === "send" && message.requestId === "reconnect-message",
    ),
  ).toHaveLength(1);
});

it("cancels an undispatched request when the phone connection closes", async () => {
  const server = await fixture();
  const desktop = await server.connect(true);
  const phone = await server.connect();
  desktop.socket.close();
  await vi.waitFor(() =>
    expect(desktop.socket.readyState).toBe(WebSocket.CLOSED),
  );
  phone.send({
    type: "send",
    requestId: "disconnected-phone",
    threadId: "thread-1",
    text: "cancel before dispatch",
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  phone.socket.close();
  await vi.waitFor(() =>
    expect(phone.socket.readyState).toBe(WebSocket.CLOSED),
  );

  const resumed = await server.connect(true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(
    resumed.messages.some(
      (message) =>
        message.type === "send" && message.requestId === "disconnected-phone",
    ),
  ).toBe(false);
});

it("bounds requests waiting for a workstation", async () => {
  const server = await fixture();
  const phone = await server.connect();
  for (let index = 0; index < 257; index++)
    phone.send({
      type: "detail",
      requestId: `waiting-${index}`,
      threadId: "thread-1",
    });

  await vi.waitFor(() =>
    expect(phone.messages).toContainEqual(
      expect.objectContaining({
        type: "result",
        requestId: "waiting-256",
        status: "failed",
        error: "工作站请求繁忙，请稍后重试",
      }),
    ),
  );
  expect(
    phone.messages.some(
      (message) =>
        message.type === "result" && message.requestId === "waiting-0",
    ),
  ).toBe(false);
  expect(phone.socket.readyState).toBe(WebSocket.OPEN);
});
