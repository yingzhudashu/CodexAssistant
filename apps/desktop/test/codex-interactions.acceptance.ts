// Acceptance gate, intentionally separate from unit tests. Fixtures follow
// codex-cli 0.153.4 generate-json-schema --experimental (2026-09-10).
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { Monitor } from '../src/monitor.js';

const state = vi.hoisted(() => ({ request: undefined as any, notification: undefined as any, socket: undefined as any, response: vi.fn(), turn: undefined as any, starts: 0, steers: 0 }));
vi.mock('../src/app-server.js', () => ({ CodexAppServer: class {
  constructor(options: any) { state.request = options.onRequest; state.notification = options.onNotification; }
  get ready() { return true; }
  async start() {} async stop() {} setTraceContext() {}
  async listThreads() { return []; }
  async resumeThread() {} latestTurn() { return state.turn; }
  async startTurn() { state.starts++; state.turn = { id: 'turn-1', status: 'inProgress' }; return { turn: state.turn }; }
  async steerTurn() { state.steers++; return { turnId: 'turn-1' }; }
  respond(id: number | string, result: unknown) { state.response(id, result); }
} }));
vi.mock('ws', () => ({ default: class extends EventEmitter {
  static OPEN = 1; readyState = 1; sent: any[] = [];
  constructor() { super(); state.socket = this; }
  send(value: string) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 3; this.emit('close'); }
} }));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const f of cleanup.splice(0)) await f(); vi.unstubAllGlobals(); state.response.mockReset(); });
async function fixture() {
  state.turn = undefined; state.starts = 0; state.steers = 0;
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200 })));
  const directory = await mkdtemp(join(tmpdir(), 'codex-interaction-audit-'));
  const monitor = await Monitor.create({ stateDirectory: directory, apiUrl: 'http://127.0.0.1:3240', token: 'synthetic-test-token', deviceId: 'test-device', onTasks() {} });
  cleanup.push(async () => { await monitor.stop(); await rm(directory, { recursive: true, force: true }); });
  await monitor.start();
  state.socket.emit("message", JSON.stringify({type:"authenticated"}));
  return state.socket;
}

it('preserves the official questions array, question IDs and labels for mobile selection', async () => {
  const socket = await fixture();
  state.request({ id: 9, method: 'item/tool/requestUserInput', params: {
    threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', isBlocking: true,
    questions: [{ id: 'theme', header: 'Appearance', question: 'Choose a theme', options: [{ label: 'Dark', description: 'Low light' }, { label: 'Light', description: 'Daylight' }] }, { id: 'name', header: 'Name', question: 'Choose a display name', options: null }],
  } });
  const request = socket.sent.find((m: any) => m.type === 'interaction.request');
  const wire = JSON.stringify(request);
  for (const text of ['theme', 'Choose a theme', 'Dark', 'Light', 'name', 'Choose a display name']) expect(wire).toContain(text);
});

it('renders official free-text questions as an editable interaction', async () => {
  const socket = await fixture();
  state.request({ id: 10, method: 'item/tool/requestUserInput', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', isBlocking: true, questions: [{ id: 'name', header: 'Name', question: 'Enter a name', options: null }] } });
  const request = socket.sent.find((m: any) => m.type === 'interaction.request');
  expect(JSON.stringify(request)).toContain('Enter a name');
  expect(request.kind === 'text' || Array.isArray(request.questions)).toBe(true);
});

it('serializes confirmation as the official decision object, not a Boolean', async () => {
  const socket = await fixture();
  state.request({ id: 11, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1', command: 'echo test', availableDecisions: ['accept', 'decline'] } });
  const request = socket.sent.find((m: any) => m.type === 'interaction.request');
  socket.emit('message', JSON.stringify({ type: 'interaction.submit', requestId: request.requestId, threadId: request.threadId, value: {decision:'accept'} }));
  expect(state.response).toHaveBeenCalledWith(11, { decision: 'accept' });
});

it('reports a failed turn carried by turn/completed as failed', async () => {
  const socket = await fixture();
  socket.emit('message', JSON.stringify({ type: 'send', requestId: 'message-1', threadId: 'thread-1', text: 'run' }));
  await vi.waitFor(() => expect(socket.sent.some((m: any) => m.status === 'started')).toBe(true));
  state.notification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'failed', error: { message: 'Synthetic failure' } } } });
  expect(socket.sent.at(-1).status).toBe('failed');
});

it('returns a submission result to the phone instead of silently discarding the request', async () => {
  const socket = await fixture();
  state.request({ id: 12, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'item-1' } });
  const request = socket.sent.find((m: any) => m.type === 'interaction.request');
  socket.emit('message', JSON.stringify({ type: 'interaction.submit', requestId: request.requestId, threadId: request.threadId, value: {decision:'decline'} }));
  expect(socket.sent.some((m: any) => m.type === 'interaction.result')).toBe(true);
});

it('serializes only RPC submission, steering subsequent messages before the turn finishes', async () => {
  const socket = await fixture();
  for (let i = 1; i <= 3; i++) socket.emit('message', JSON.stringify({ type: 'send', requestId: `send-${i}`, threadId: 'thread-1', text: `message ${i}` }));
  await vi.waitFor(() => expect(socket.sent.filter((m: any) => m.type === 'result' && m.status === 'started')).toHaveLength(3));
  expect(state.starts).toBe(1); expect(state.steers).toBe(2);
  state.notification({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  expect(socket.sent.filter((m: any) => m.status === 'completed').map((m: any) => m.requestId)).toEqual(['send-1', 'send-2', 'send-3']);
});
