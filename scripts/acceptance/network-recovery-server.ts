import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../apps/server/src/app.js';

// Isolated real protocol server; never connects to production or a Codex session.
const directory = await mkdtemp(join(tmpdir(), 'codex-network-recovery-'));
const token = 'synthetic-acceptance-token';
const server = await createApp({ databasePath: join(directory, 'state.sqlite'), accessToken: token, logger: false });
let connections = 0;
let snapshots = 0;
let writes = 0;
server.app.websocketServer.on('connection', peer => {
  connections++;
  peer.on('message', data => {
    const message = JSON.parse(String(data));
    if (message.type === 'subscribe') snapshots++;
    if (message.type === 'send' || message.type === 'interaction.submit') writes++;
  });
});
server.app.get('/acceptance/network', async () => ({
  connections, snapshots, writes, active: server.app.websocketServer.clients.size,
}));
server.app.post('/acceptance/disconnect', async () => {
  for (const peer of server.app.websocketServer.clients) peer.close(1013, 'acceptance reconnect');
  return { closed: true };
});
await server.app.listen({ host: '127.0.0.1', port: 33241 });
const now = new Date().toISOString();
await server.app.inject({ method: 'POST', url: '/codex-assistant/api/v3/events',
  headers: { authorization: `Bearer ${token}` }, payload: {
    protocolVersion: 'codex-assistant.v3', deviceId: 'acceptance', localSequence: 1, occurredAt: now,
    trace: { traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef' },
    task: { id: 'network-test', title: '网络恢复验收', status: 'running', runtimeStatus: 'active',
      activeFlags: [], freshness: 'fresh', source: 'thread', plan: [], updatedAt: now, changedAt: now },
  } });
console.log('Network recovery acceptance server ready on 127.0.0.1:33241');
process.on('SIGINT', async () => { await server.close(); await rm(directory, { recursive: true, force: true }); process.exit(); });
