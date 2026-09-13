import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { CodexDesktopHost, NativeHostPipe } from '../src/codex-host.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const frame = (value: unknown) => {
  const payload = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length); return Buffer.concat([header, payload]);
};
async function fixture(handler: (message: any, socket: net.Socket) => void) {
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\ca-host-test-${randomUUID()}` : join(tmpdir(), `ca-${randomUUID()}.sock`);
  const sockets = new Set<net.Socket>(); const messages: any[] = [];
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE()) {
        const length = buffer.readUInt32LE(); const message = JSON.parse(buffer.subarray(4, length + 4).toString());
        buffer = buffer.subarray(length + 4); messages.push(message); handler(message, socket);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  cleanups.push(async () => { sockets.forEach(socket => socket.destroy()); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { path, messages, sockets };
}
const reply = (socket: net.Socket, id: number, result: unknown) => socket.write(frame({ jsonrpc: '2.0', id, result }));
const catalog = { tools: [{ name: 'send_message_to_thread', namespace: 'codex_app' }] };

it('shares concurrent connections and matches fragmented, coalesced out-of-order replies', async () => {
  const f = await fixture((m, socket) => {
    if (f.messages.length !== 2) return;
    const bytes = Buffer.concat([frame({ jsonrpc: '2.0', id: m.id, result: 'second' }), frame({ jsonrpc: '2.0', id: f.messages[0].id, result: 'first' })]);
    socket.write(bytes.subarray(0, 2)); setImmediate(() => socket.write(bytes.subarray(2)));
  });
  const pipe = new NativeHostPipe(f.path); cleanups.push(() => pipe.close());
  expect(await Promise.all([pipe.request('one', {}), pipe.request('two', {})])).toEqual(['first', 'second']);
  expect(f.sockets.size).toBe(1);
});

it.each([null, [], { jsonrpc: '2.0', id: 1 }, { jsonrpc: '2.0', id: 1, result: true, error: {} }])('rejects malformed response %j without crashing', async value => {
  const f = await fixture((_m, socket) => socket.write(frame(value)));
  const pipe = new NativeHostPipe(f.path); cleanups.push(() => pipe.close());
  await expect(pipe.request('read', {})).rejects.toThrow('CODEX_HOST_INVALID_RESPONSE');
});

it('rejects oversized frames and times out unanswered RPCs', async () => {
  const huge = await fixture((_m, socket) => { const h = Buffer.alloc(4); h.writeUInt32LE(8 * 1024 * 1024 + 1); socket.write(h); });
  const pipe = new NativeHostPipe(huge.path); cleanups.push(() => pipe.close());
  await expect(pipe.request('read', {})).rejects.toThrow('CODEX_HOST_INVALID_RESPONSE');
  const silent = await fixture(() => {}); const silentPipe = new NativeHostPipe(silent.path); cleanups.push(() => silentPipe.close());
  await expect(silentPipe.request('write', {}, 25)).rejects.toThrow('CODEX_HOST_TIMEOUT');
  expect(silent.messages).toHaveLength(1);
});

it('closes pending calls immediately when the monitor stops', async () => {
  const f = await fixture(() => {}); const pipe = new NativeHostPipe(f.path);
  const result = expect(pipe.request('read', {})).rejects.toThrow('CODEX_HOST_PIPE_CLOSED');
  await vi.waitFor(() => expect(f.messages).toHaveLength(1)); pipe.close(); await result;
});

it('never retries a write with a lost acknowledgement, and rediscovers on a later manual send', async () => {
  let writes = 0;
  const f = await fixture((m, socket) => {
    if (m.method === 'tools/list') return void reply(socket, m.id, catalog);
    writes++; if (writes === 1) socket.destroy(); else reply(socket, m.id, { success: true, contentItems: [] });
  });
  const host = new CodexDesktopHost(async () => [f.path]); cleanups.push(() => host.close());
  await expect(host.sendMessage('thread', 'first')).rejects.toThrow('CODEX_HOST_PIPE_CLOSED');
  expect(writes).toBe(1);
  await host.sendMessage('thread', 'manual retry'); expect(writes).toBe(2);
  expect(f.messages.filter(m => m.method === 'tools/list')).toHaveLength(2);
  expect(f.messages.at(-1).params.arguments).toEqual({ threadId: 'thread', prompt: 'manual retry' });
});

it.each([false, null, 'true'])('does not turn success=%j into acceptance', async success => {
  const f = await fixture((m, socket) => reply(socket, m.id, m.method === 'tools/list' ? catalog : { success, contentItems: [] }));
  const host = new CodexDesktopHost(async () => [f.path]); cleanups.push(() => host.close());
  await expect(host.sendMessage('thread', 'message')).rejects.toThrow(success === false ? 'CODEX_DESKTOP_SEND_REJECTED' : 'CODEX_HOST_INVALID_RESPONSE');
  expect(f.messages.filter(m => m.method === 'tools/call')).toHaveLength(1);
});

it('refuses ambiguous hosts and closes unsupported discovery sockets', async () => {
  const a = await fixture((m, socket) => reply(socket, m.id, catalog));
  const b = await fixture((m, socket) => reply(socket, m.id, catalog));
  const other = await fixture((m, socket) => reply(socket, m.id, { tools: [] }));
  const host = new CodexDesktopHost(async () => [a.path, other.path, b.path]); cleanups.push(() => host.close());
  await expect(host.sendMessage('thread', 'message')).rejects.toThrow('CODEX_DESKTOP_HOST_AMBIGUOUS');
  await vi.waitFor(() => expect(a.sockets.size + b.sockets.size + other.sockets.size).toBe(0));
  expect([...a.messages, ...b.messages].every(m => m.method === 'tools/list')).toBe(true);
});
