import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createApp } from '../../apps/server/src/app.js';

// 专用模拟器的真实HTTP/WS通知验收；不连接生产或任何Codex会话。
const directory = await mkdtemp(join(tmpdir(), 'codex-notifications-'));
const token = 'synthetic-acceptance-token';
const server = await createApp({ databasePath: join(directory, 'state.sqlite'), accessToken: token, logger: false });
let sequence = 0;
let snapshots = 0;
const traces: string[] = [];
async function update(status: string) {
  if (!['running', 'completed', 'needs_action', 'failed'].includes(status)) throw new Error('Invalid synthetic status');
  const occurredAt = new Date().toISOString();
  const traceId = randomBytes(16).toString('hex');
  const response = await server.app.inject({ method: 'POST', url: '/codex-assistant/api/v3/events', headers: { authorization: `Bearer ${token}` }, payload: {
    protocolVersion: 'codex-assistant.v3', deviceId: 'notifications-acceptance', localSequence: ++sequence, occurredAt,
    trace: { traceId, spanId: randomBytes(8).toString('hex') },
    task: { id: 'notification-test', title: '通知即时验收', status, runtimeStatus: status === 'running' ? 'active' : 'idle', activeFlags: [], freshness: 'fresh', source: 'thread', plan: [], updatedAt: occurredAt, changedAt: occurredAt },
  } });
  if (response.statusCode !== 200) throw new Error('Synthetic event rejected');
  traces.push(traceId);
  return { traceId, sequence, occurredAt };
}
server.app.websocketServer.on('connection', peer => peer.on('message', raw => {
  if (JSON.parse(String(raw)).type === 'subscribe') snapshots++;
}));
server.app.post<{ Body: { status: string } }>('/acceptance/state', async request => update(request.body.status));
server.app.post<{ Body: { status: string } }>('/acceptance/reconnect', async request => {
  for (const peer of server.app.websocketServer.clients) peer.close(1013, 'synthetic reconnect');
  return update(request.body.status);
});
server.app.get('/acceptance/metrics', async () => ({ sequence, snapshots, active: server.app.websocketServer.clients.size }));
server.app.get('/acceptance/latency', async () => {
  const spans = [];
  for (const traceId of traces) {
    const response = await server.app.inject({ method: 'GET', url: `/codex-assistant/api/v3/traces/${traceId}`, headers: { authorization: `Bearer ${token}` } });
    if (response.statusCode === 200) spans.push(...response.json().spans.filter((span: { name: string }) => span.name === 'android.sync.notification_delivery'));
  }
  return { count: spans.length, latencyMs: spans.map(span => Number(span.attributes?.latencyMs)) };
});
await server.app.listen({ host: '127.0.0.1', port: 33241 });
await update('running');
console.log('Notification acceptance server ready on 127.0.0.1:33241');
process.on('SIGINT', async () => { await server.close(); await rm(directory, { recursive: true, force: true }); process.exit(); });
