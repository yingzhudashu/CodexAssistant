import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function frame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length > MAX_FRAME_BYTES) throw new Error("CODEX_HOST_REQUEST_TOO_LARGE");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length);
  return Buffer.concat([header, payload]);
}

async function candidatePipes(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  try {
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", "Get-ChildItem -Name '\\\\.\\pipe\\' | Where-Object { $_ -like 'codex-browser-use-*' }"], { timeout: 2_000, windowsHide: true, maxBuffer: 64 * 1024 });
    return [...new Set(stdout.split(/\r?\n/).map(name => name.trim()).filter(name => /^codex-browser-use-[a-f0-9-]+$/.test(name)))].map(name => `\\\\.\\pipe\\${name}`);
  } catch { return []; }
}

// This transport speaks the framing used by the bundled codex-app-tools plugin.
export class NativeHostPipe {
  #socket?: net.Socket;
  #connecting?: Promise<net.Socket>;
  #nextId = 1;
  #closed = false;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  #buffer = Buffer.alloc(0);
  constructor(readonly path: string) {}

  close(): void {
    this.#closed = true;
    this.#disconnect(new Error("CODEX_HOST_PIPE_CLOSED"));
  }

  async request(method: string, params: Record<string, unknown>, timeoutMs = 10_000): Promise<unknown> {
    const id = this.#nextId++;
    const payload = frame({ id, jsonrpc: "2.0", method, params });
    const socket = await this.#connect();
    if (this.#closed || socket.destroyed) throw new Error("CODEX_HOST_PIPE_CLOSED");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#disconnect(new Error("CODEX_HOST_TIMEOUT")), timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      socket.write(payload, error => { if (error) this.#disconnect(new Error("CODEX_HOST_PIPE_CLOSED")); });
    });
  }

  async #connect(): Promise<net.Socket> {
    if (this.#closed) throw new Error("CODEX_HOST_PIPE_CLOSED");
    if (this.#connecting) return this.#connecting;
    if (this.#socket && !this.#socket.destroyed) return this.#socket;
    this.#connecting = new Promise<net.Socket>((resolve, reject) => {
      const socket = net.createConnection(this.path);
      this.#socket = socket;
      const timer = setTimeout(() => socket.destroy(new Error("CODEX_HOST_CONNECT_TIMEOUT")), 2_000);
      socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
      socket.on("data", chunk => this.#onData(chunk));
      socket.on("error", () => {
        clearTimeout(timer);
        const error = new Error("CODEX_HOST_PIPE_CLOSED");
        reject(error); this.#disconnect(error);
      });
      socket.on("close", () => {
        clearTimeout(timer);
        const error = new Error("CODEX_HOST_PIPE_CLOSED");
        reject(error); this.#disconnect(error);
      });
    });
    try { return await this.#connecting; } finally { this.#connecting = undefined; }
  }

  #onData(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (!length || length > MAX_FRAME_BYTES) { this.#disconnect(new Error("CODEX_HOST_INVALID_RESPONSE")); return; }
      if (this.#buffer.length < length + 4) return;
      const payload = this.#buffer.subarray(4, length + 4);
      this.#buffer = this.#buffer.subarray(length + 4);
      let message: unknown;
      try { message = JSON.parse(payload.toString("utf8")); } catch { this.#disconnect(new Error("CODEX_HOST_INVALID_RESPONSE")); return; }
      if (!record(message) || message.jsonrpc !== "2.0" || !Number.isInteger(message.id) || (("result" in message) === ("error" in message))) {
        this.#disconnect(new Error("CODEX_HOST_INVALID_RESPONSE")); return;
      }
      const pending = this.#pending.get(message.id as number);
      if (!pending) continue;
      this.#pending.delete(message.id as number);
      clearTimeout(pending.timer);
      if ("error" in message) pending.reject(new Error("CODEX_HOST_RPC_ERROR"));
      else pending.resolve(message.result);
    }
  }

  #disconnect(error: Error): void {
    this.#closed = true;
    const socket = this.#socket;
    this.#socket = undefined;
    this.#buffer = Buffer.alloc(0);
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    socket?.destroy();
  }
}

export class CodexDesktopHost {
  #pipe?: NativeHostPipe;
  #discovering?: Promise<NativeHostPipe>;
  #closed = false;
  #connections = new Set<NativeHostPipe>();
  constructor(private readonly candidates: () => Promise<string[]> = candidatePipes) {}

  close(): void {
    this.#closed = true;
    for (const pipe of this.#connections) pipe.close();
    this.#connections.clear();
    this.#pipe = undefined;
  }

  async sendMessage(threadId: string, text: string): Promise<void> {
    const pipe = await this.#getPipe();
    try {
      const result = await pipe.request("tools/call", {
        arguments: { threadId, prompt: text },
        callId: `codex-assistant-${randomUUID()}`,
        namespace: "codex_app", threadId, tool: "send_message_to_thread",
        turnId: `mcp-turn-${randomUUID()}`,
      });
      if (record(result) && result.success === false) throw new Error("CODEX_DESKTOP_SEND_REJECTED");
      if (!record(result) || result.success !== true || !Array.isArray(result.contentItems) || !result.contentItems.every(item => record(item) && (
        (item.type === "inputText" && typeof item.text === "string") ||
        (item.type === "inputImage" && typeof item.imageUrl === "string") ||
        (item.type === "inputAudio" && typeof item.audioUrl === "string")
      ))) throw new Error("CODEX_HOST_INVALID_RESPONSE");
    } catch (error) {
      // A lost acknowledgement is an unknown write, never permission to replay.
      pipe.close(); this.#connections.delete(pipe);
      if (this.#pipe === pipe) this.#pipe = undefined;
      throw error;
    }
  }

  async #getPipe(): Promise<NativeHostPipe> {
    if (this.#closed) throw new Error("CODEX_DESKTOP_HOST_UNAVAILABLE");
    if (this.#pipe) return this.#pipe;
    if (this.#discovering) return this.#discovering;
    this.#discovering = (async () => {
      const candidates = await this.candidates();
      const matches = (await Promise.all([...new Set(candidates)].map(async path => {
        if (this.#closed) return undefined;
        const pipe = new NativeHostPipe(path);
        this.#connections.add(pipe);
        try {
          const result = await pipe.request("tools/list", { threadStartKind: "all" }, 2_000);
          if (record(result) && Array.isArray(result.tools) && result.tools.some(tool => record(tool) && tool.name === "send_message_to_thread" && tool.namespace === "codex_app")) return pipe;
        } catch { /* Only discovery is read-only. A write is never retried. */ }
        pipe.close(); this.#connections.delete(pipe);
        return undefined;
      }))).filter((pipe): pipe is NativeHostPipe => Boolean(pipe));
      if (matches.length !== 1 || this.#closed) {
        for (const pipe of matches) { pipe.close(); this.#connections.delete(pipe); }
        throw new Error(matches.length > 1 ? "CODEX_DESKTOP_HOST_AMBIGUOUS" : "CODEX_DESKTOP_HOST_UNAVAILABLE");
      }
      return this.#pipe = matches[0];
    })();
    try { return await this.#discovering; } finally { this.#discovering = undefined; }
  }
}
