import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../../apps/server/src/app.js';
import { CodexAppServer } from '../../apps/desktop/src/app-server.js';
import { createInteraction, interactionResponse, type PendingInteraction } from '../../apps/desktop/src/interactions.js';
const directory = await mkdtemp(join(tmpdir(), 'codex-official-android-'));
const token = 'synthetic-acceptance-token';
const relay = await createApp({ databasePath: join(directory, 'state.sqlite'), accessToken: token, logger: false });
const report = { initialized: false, model: '', requestReceived: false, androidAnswerReceived: false, responseWritten: false, completed: false, error: '' };
const persist = () => writeFile('artifacts/acceptance/official-android.json', JSON.stringify(report, null, 2) + '\n');
let pending: PendingInteraction | undefined;
let threadId = '';
let sequence = 0;
let started = false;
let timer: NodeJS.Timeout | undefined;
let ws: WebSocket;
const send = (value: unknown) => ws.send(JSON.stringify(value));
async function publish(status: string) {
  const now = new Date().toISOString();
  await relay.app.inject({ method: 'POST', url: '/codex-assistant/api/v3/events', headers: { authorization: `Bearer ${token}` }, payload: { protocolVersion: 'codex-assistant.v3', deviceId: 'official-acceptance', localSequence: ++sequence, occurredAt: now, trace: { traceId: '0123456789abcdef0123456789abcdef', spanId: sequence.toString(16).padStart(16,'0') }, task: { id: threadId, title: '官方 Codex 选项验收', status, runtimeStatus: status === 'running' ? 'active' : 'idle', activeFlags: [], freshness: 'fresh', source: 'thread', plan: [], updatedAt: now, changedAt: now } } });
}
const codex = new CodexAppServer({
  onRequest: rpc => {
    if (rpc.method !== 'item/tool/requestUserInput') { codex.respondError(rpc.id, -32601, 'Not in this acceptance scenario'); return; }
    pending = createInteraction(rpc)!; report.requestReceived = true;
    void publish('needs_action'); send(pending.request); void persist();
  },
  onNotification: n => {
    if (n.method === 'turn/completed') {
      report.completed = (n.params.turn as { status?: string }).status === 'completed';
      if (timer) clearTimeout(timer);
      void publish(report.completed ? 'completed' : 'failed'); void persist();
    }
  },
});
relay.app.post('/acceptance/start', async () => {
  if (started) return { started: true };
  started = true;
  await codex.start(); report.initialized = true;
  const t = await codex.request('thread/start', { cwd: directory, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true }) as { thread: { id: string }; model: string };
  threadId = t.thread.id; report.model = t.model;
  await publish('running');
  await codex.request('turn/start', { threadId, input: [{ type: 'text', text: 'This is an isolated Android protocol acceptance test. Use request_user_input now to ask exactly one question with two options labeled Alpha and Beta. Do not inspect files or call other tools. After the answer arrives, reply only DONE.' }], collaborationMode: { mode: 'plan', settings: { model: t.model, reasoning_effort: 'low', developer_instructions: null } } });
  timer = setTimeout(() => { report.error = 'ACCEPTANCE_TIMEOUT'; void persist(); }, 300_000);
  await persist(); return { started: true };
});
await relay.app.listen({ host: '127.0.0.1', port: 33241 });
ws = new WebSocket('ws://127.0.0.1:33241/codex-assistant/api/v3/stream');
ws.on('open', () => send({ type: 'auth', protocolVersion: 'codex-assistant.v3', token }));
ws.on('message', async raw => {
  const m = JSON.parse(String(raw));
  if (m.type === 'authenticated') { send({ type: 'subscribe', protocolVersion: 'codex-assistant.v3', after: 0 }); send({ type: 'role', protocolVersion: 'codex-assistant.v3', role: 'desktop' }); }
  if (m.type === 'interaction.submit' && pending && m.requestId === pending.request.requestId && m.threadId === threadId) {
    try {
      report.androidAnswerReceived = true;
      const response = interactionResponse(pending, m.value);
      codex.respond(pending.rpc.id, response.result); report.responseWritten = true;
      send({ type: 'interaction.result', protocolVersion: 'codex-assistant.v3', requestId: m.requestId, threadId, status: response.cancel ? 'cancelled' : 'submitted' }); pending = undefined; await persist();
    } catch { report.error = 'INVALID_ANSWER'; await persist(); }
  }
});
console.log('Official Android acceptance ready on 127.0.0.1:33241; POST /acceptance/start');
process.on('SIGINT', async () => { if(timer) clearTimeout(timer); await codex.stop(); ws.terminate(); await relay.close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); await persist(); process.exit(); });
