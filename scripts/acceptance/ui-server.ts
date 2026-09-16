import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../../apps/server/src/app.js';
import { createInteraction, interactionResponse } from '../../apps/desktop/src/interactions.js';
const directory = await mkdtemp(join(tmpdir(), 'codex-ui-acceptance-'));
const token = 'synthetic-acceptance-token';
const server = await createApp({ databasePath: join(directory, 'state.sqlite'), accessToken: token, logger: false });
const task = { id: 'synthetic-thread', title: '移动端验收任务', status: 'needs_action', runtimeStatus: 'idle', activeFlags: [], freshness: 'fresh', source: 'thread', plan: [], updatedAt: new Date().toISOString(), changedAt: new Date().toISOString() };
let localSequence = 1;
let controllerSocket: WebSocket | undefined;
server.app.websocketServer.on('connection', peer => peer.on('message', raw => {
  const value = JSON.parse(String(raw)); if (value.type === 'role') controllerSocket = peer;
}));
server.app.post('/acceptance/state', async (request, reply) => {
  const status = (request.body as { status: string }).status;
  if (!['running','needs_action','failed','completed'].includes(status)) return reply.code(400).send({ error: 'invalid status' });
  const now = new Date().toISOString();
  await server.app.inject({ method: 'POST', url: '/codex-assistant/api/v3/events', headers: { authorization: `Bearer ${token}` }, payload: { protocolVersion: 'codex-assistant.v3', deviceId: 'synthetic', localSequence: ++localSequence, occurredAt: now, trace: { traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef' }, task: { ...task, status, updatedAt: now, changedAt: now } } });
  return { updated: true };
});
server.app.post('/acceptance/disconnect', async () => {
  for (const peer of server.app.websocketServer.clients) if (peer !== controllerSocket) peer.close(1013, 'Synthetic backpressure test');
  return { closed: true };
});
await server.app.listen({ host: '127.0.0.1', port: 33241 });
await server.app.inject({ method: 'POST', url: '/codex-assistant/api/v3/events', headers: { authorization: `Bearer ${token}` }, payload: { protocolVersion: 'codex-assistant.v3', deviceId: 'synthetic', localSequence: 1, occurredAt: new Date().toISOString(), trace: { traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef' }, task } });
const pending = createInteraction({ id: 9, method: 'mcpServer/elicitation/request', params: { threadId: task.id, serverName: 'acceptance', mode: 'form', message: '选择本次验证范围', requestedSchema: { type: 'object', required: ['checks', 'note'], properties: { checks: { type: 'array', title: '验证范围', description: '可以选择多项', minItems: 2, items: { type: 'string', enum: ['连接', '设置', '消息'] } }, note: { type: 'string', title: '补充说明', description: '填写本次验证说明' } } } } })!;
const ws = new WebSocket('ws://127.0.0.1:33241/codex-assistant/api/v3/stream');
const send = (v: unknown) => ws.send(JSON.stringify(v));
ws.on('open', () => send({ type: 'auth', protocolVersion: 'codex-assistant.v3', token }));
ws.on('message', async data => {
  const m = JSON.parse(String(data));
  if (m.type === 'authenticated') { send({ type: 'subscribe', protocolVersion: 'codex-assistant.v3', after: 0 }); send({ type: 'role', protocolVersion: 'codex-assistant.v3', role: 'desktop' }); send(pending.request); }
  if (m.type === 'interaction.submit') {
    try {
      const official = interactionResponse(pending, m.value);
      await writeFile('artifacts/acceptance/android-roundtrip.json', JSON.stringify({ received: true, officialResponseValidated: true, cancelled: official.cancel }, null, 2));
      send({ type: 'interaction.result', protocolVersion: 'codex-assistant.v3', requestId: m.requestId, threadId: m.threadId, status: official.cancel ? 'cancelled' : 'submitted' });
    } catch { send({ type: 'interaction.result', protocolVersion: 'codex-assistant.v3', requestId: m.requestId, threadId: m.threadId, status: 'failed', error: '请选择至少两项并填写说明' }); }
  }
  if (m.type === 'detail') send({ type: 'detail', protocolVersion: 'codex-assistant.v3', requestId: m.requestId, threadId: m.threadId, turns: [{id:'synthetic-turn',status:'completed',items:[{type:'agentMessage',text:'合成验收摘要：连接、详情和消息回执可用。'}]}] });
  if (m.type === 'send') send({ type: 'result', protocolVersion: 'codex-assistant.v3', requestId: m.requestId, threadId: m.threadId, status: 'started' });
});
console.log('Synthetic UI acceptance server ready on loopback port 33241');
process.on('SIGINT', async () => { ws.terminate(); await server.close(); await rm(directory, { recursive: true, force: true }); process.exit(); });
