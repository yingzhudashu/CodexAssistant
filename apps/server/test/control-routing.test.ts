import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@codex-assistant/protocol';
import { createApp } from '../src/app.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'codex-control-'));
  const server = await createApp({ databasePath: join(dir, 'state.sqlite'), accessToken: 'control-routing-test-token', logger: false });
  const peers: WebSocket[] = [];
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const address = server.app.server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  cleanups.push(async () => { peers.forEach(p => p.terminate()); await server.close(); await rm(dir, { recursive: true, force: true }); });
  async function connect(desktop = false) {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/codex-assistant/api/v3/stream`);
    peers.push(socket);
    const messages: any[] = [];
    socket.on('message', data => messages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    const send = (value: Record<string, unknown>) => socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...value }));
    send({ type: 'auth', token: 'control-routing-test-token' });
    send({ type: 'subscribe', after: 0 });
    await vi.waitFor(() => expect(messages.some(m => m.type === 'snapshot')).toBe(true));
    if (desktop) { send({ type: 'role', role: 'desktop' }); await new Promise(r => setTimeout(r, 20)); }
    return { socket, messages, send };
  }
  return { connect, server };
}

it('finishes a send at acceptance and does not overwrite it when the workstation disconnects', async () => {
  const f = await fixture(); const desktop = await f.connect(true); const phone = await f.connect();
  phone.send({ type: 'send', requestId: 'message-1', threadId: 'thread-1', text: 'continue' });
  await vi.waitFor(() => expect(desktop.messages.some(m => m.type === 'send')).toBe(true));
  desktop.send({ type: 'result', requestId: 'message-1', threadId: 'thread-1', status: 'started' });
  await vi.waitFor(() => expect(phone.messages.filter(m => m.type === 'result')).toHaveLength(1));
  desktop.socket.close();
  await vi.waitFor(() => expect(desktop.socket.readyState).toBe(WebSocket.CLOSED));
  expect(phone.messages.filter(m => m.type === 'result').map(m => m.status)).toEqual(['started']);
});

it('expires unanswered control requests without replaying a write or closing the phone', async () => {
  const f = await fixture(); const desktop = await f.connect(true); const phone = await f.connect();
  phone.send({ type: 'send', requestId: 'timeout-message', threadId: 'thread', text: 'synthetic' });
  await vi.waitFor(() => expect(desktop.messages.some(m => m.requestId === 'timeout-message')).toBe(true));
  const future = Date.now() + 31_000;
  const now = vi.spyOn(Date, 'now').mockReturnValue(future);
  try { await vi.waitFor(() => expect(phone.messages.some(m => m.requestId === 'timeout-message' && m.status === 'failed')).toBe(true), { timeout: 2000 }); }
  finally { now.mockRestore(); }
  expect(phone.socket.readyState).toBe(WebSocket.OPEN);
  expect(desktop.messages.filter(m => m.requestId === 'timeout-message')).toHaveLength(1);
});

it('bounds pending control requests and gives an actionable overload result', async () => {
  const f = await fixture(); const desktop = await f.connect(true); const phone = await f.connect();
  for (let i = 0; i < 257; i++) phone.send({ type: 'detail', requestId: `bounded-${i}`, threadId: 'thread' });
  await vi.waitFor(() => expect(phone.messages.some(m => m.requestId === 'bounded-256' && m.status === 'failed')).toBe(true));
  expect(desktop.messages.filter(m => m.type === 'detail')).toHaveLength(256);
  expect(phone.socket.readyState).toBe(WebSocket.OPEN);
});

it('rejects a cross-thread result instead of delivering it to another conversation', async () => {
  const f = await fixture(); const desktop = await f.connect(true); const phone = await f.connect();
  phone.send({ type: 'send', requestId: 'message-1', threadId: 'thread-1', text: 'continue' });
  await vi.waitFor(() => expect(desktop.messages.some(m => m.type === 'send')).toBe(true));
  desktop.send({ type: 'result', requestId: 'message-1', threadId: 'different-thread', status: 'started' });
  await vi.waitFor(() => expect(desktop.socket.readyState).not.toBe(WebSocket.OPEN));
  expect(phone.messages.some(m => m.type === 'result' && m.threadId === 'different-thread')).toBe(false);
});

it('returns a correlated offline error without closing the phone connection', async () => {
  const f = await fixture(); const phone = await f.connect();
  phone.send({ type: 'send', requestId: 'offline-1', threadId: 'thread-1', text: 'continue' });
  await vi.waitFor(() => expect(phone.messages).toContainEqual(expect.objectContaining({ type: 'result', requestId: 'offline-1', threadId: 'thread-1', status: 'failed' })));
  expect(phone.socket.readyState).toBe(WebSocket.OPEN);
});

it('routes one interaction submission across two clients and replays terminal receipts', async () => {
  const f = await fixture(); const desktop = await f.connect(true); const first = await f.connect(); const second = await f.connect();
  desktop.send({ type: 'interaction.request', requestId: 'choice-1', threadId: 'thread-1', kind: 'confirm', title: 'Approve test' });
  await vi.waitFor(() => expect(first.messages.some(m => m.type === 'interaction.request')).toBe(true));
  const submit = { type: 'interaction.submit', requestId: 'choice-1', threadId: 'thread-1', value: { decision: 'accept' } };
  first.send(submit); second.send(submit);
  await vi.waitFor(() => expect(desktop.messages.filter(m => m.type === 'interaction.submit')).toHaveLength(1));
  desktop.send({ type: 'interaction.result', requestId: 'choice-1', threadId: 'thread-1', status: 'submitted' });
  await vi.waitFor(() => expect(second.messages.some(m => m.type === 'interaction.result' && m.status === 'submitted')).toBe(true));
  const reconnected = await f.connect();
  expect(reconnected.messages.some(m => m.type === 'interaction.result' && m.status === 'submitted')).toBe(true);
  first.send(submit);
  await vi.waitFor(() => expect(first.messages.filter(m => m.type === 'interaction.result')).toHaveLength(2));
  expect(desktop.messages.filter(m => m.type === 'interaction.submit')).toHaveLength(1);
  expect(first.socket.readyState).toBe(WebSocket.OPEN);
});

it('retains pending forms after a validation failure and expires unknown IDs without disconnecting', async () => {
  const f = await fixture(); const desktop = await f.connect(true); const phone = await f.connect();
  desktop.send({ type: 'interaction.request', requestId: 'choice-2', threadId: 'thread-1', kind: 'confirm', title: 'Approve test' });
  await vi.waitFor(() => expect(phone.messages.some(m => m.type === 'interaction.request')).toBe(true));
  const submit = { type: 'interaction.submit', requestId: 'choice-2', threadId: 'thread-1', value: { decision: 'invalid' } };
  phone.send(submit);
  await vi.waitFor(() => expect(desktop.messages.filter(m => m.type === 'interaction.submit')).toHaveLength(1));
  desktop.send({ type: 'interaction.result', requestId: 'choice-2', threadId: 'thread-1', status: 'failed', error: 'Invalid answer' });
  await vi.waitFor(() => expect(phone.messages.some(m => m.status === 'failed')).toBe(true));
  phone.send({ ...submit, value: { decision: 'accept' } });
  await vi.waitFor(() => expect(desktop.messages.filter(m => m.type === 'interaction.submit')).toHaveLength(2));
  phone.send({ ...submit, requestId: 'expired-id' });
  await vi.waitFor(() => expect(phone.messages.some(m => m.requestId === 'expired-id' && m.status === 'expired')).toBe(true));
  expect(phone.socket.readyState).toBe(WebSocket.OPEN);
});


it('forwards 20000 Chinese characters within the documented message limit', async () => {
  const f = await fixture(); const desktop = await f.connect(true); const phone = await f.connect();
  const text = '验'.repeat(20_000);
  phone.send({ type: 'send', requestId: 'unicode-message', threadId: 'thread-1', text });
  await vi.waitFor(() => expect(desktop.messages.find(m => m.requestId === 'unicode-message')?.text).toBe(text));
  expect(phone.socket.readyState).toBe(WebSocket.OPEN);
});

it('closes a backpressured subscriber and restores the latest task on reconnect', async () => {
  const f = await fixture(); const phone = await f.connect();
  const serverSocket = [...f.server.app.websocketServer.clients][0];
  Object.defineProperty(serverSocket, 'bufferedAmount', { configurable: true, get: () => 256 * 1024 });
  let closeCode: number | undefined;
  phone.socket.once('close', code => { closeCode = code; });
  const now = new Date().toISOString();
  const response = await f.server.app.inject({ method: 'POST', url: '/codex-assistant/api/v3/events', headers: { authorization: 'Bearer control-routing-test-token' }, payload: {
    protocolVersion: PROTOCOL_VERSION, deviceId: 'slow-test', localSequence: 1, occurredAt: now,
    trace: { traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef' },
    task: { id: 'slow-thread', title: 'Slow subscriber task', status: 'running', runtimeStatus: 'active', activeFlags: [], freshness: 'fresh', source: 'thread', plan: [], updatedAt: now, changedAt: now },
  } });
  expect(response.statusCode).toBe(200);
  await vi.waitFor(() => expect(closeCode).toBe(1013));
  const restored = await f.connect();
  expect(restored.messages.find(m => m.type === 'snapshot')?.tasks).toContainEqual(expect.objectContaining({ id: 'slow-thread', status: 'running' }));
  expect(restored.messages.some(m => m.type === 'event' && m.event.sequence === 1)).toBe(true);
});


it('replays a large pending-form set after the snapshot without disconnecting a healthy reader', async () => {
  const f = await fixture(); const desktop = await f.connect(true);
  // 300个独立表单的总字节超过256KiB，不能一次排队后把健康重连误判为慢消费者。
  for (let i=0;i<300;i++) desktop.send({ type:'interaction.request',requestId:`large-form-${i}`,threadId:'thread',kind:'text',title:'Synthetic form',description:'x'.repeat(500),questions:[{id:'answer',header:'Answer',question:'y'.repeat(500),required:true,multiple:false,isOther:false,isSecret:false}] });
  // pong与前面的帧在同一TCP流中有序处理，作为表单已接收的屏障。
  const pong = new Promise<void>(resolve => desktop.socket.once('pong', () => resolve()));
  desktop.socket.ping(); await pong;
  const probe = await f.connect();
  await vi.waitFor(()=>expect(probe.messages.filter(m=>m.type==='interaction.request')).toHaveLength(300),{timeout:5000});
  expect(probe.socket.readyState).toBe(WebSocket.OPEN);
  expect(probe.messages.findIndex(m=>m.type==='snapshot')).toBeLessThan(probe.messages.findIndex(m=>m.type==='interaction.request'));
});
