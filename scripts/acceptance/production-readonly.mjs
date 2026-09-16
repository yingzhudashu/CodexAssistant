import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// 在生产服务器执行：凭据仅留在本进程，不输出任务正文、标识或 Token。
// 仅发起健康检查、读取任务、订阅快照和查询 Trace，不写业务事件或发送消息。
// 必须显式指定目标；默认地址可能让验收误连到维护者的私人服务。
const origin = process.argv[2];
assert(origin && /^https:\/\/[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/.test(origin), 'Usage: node production-readonly.mjs https://server.example.com');
const require = createRequire('/opt/codex-assistant/current/apps/server/package.json');
const WebSocket = require('ws');
const environment = readFileSync('/etc/codex-assistant/codex-assistant.env', 'utf8');
const token = environment.match(/^CODEX_ASSISTANT_ACCESS_TOKEN=(.+)$/m)?.[1].trim();
assert(token && token.length >= 16, 'Production credential is missing');
const base = `${origin}/codex-assistant`;
const protocolVersion = 'codex-assistant.v3';
const headers = { authorization: `Bearer ${token}` };
const get = (path, extra = {}) => fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000), ...extra });
const before = await (await get('/health')).json();
assert.equal(before.status, 'ok');
assert.equal(before.protocolVersion, protocolVersion);
assert.equal(before.traceFailedExports, 0);
assert(before.cpuUsageMicros);
assert.equal((await get('/api/v3/tasks')).status, 401);

const traceId = randomBytes(16).toString('hex');
const parentSpanId = randomBytes(8).toString('hex');
const response = await get('/api/v3/tasks', { headers: { ...headers, traceparent: `00-${traceId}-${parentSpanId}-01` } });
assert.equal(response.status, 200);
const tasks = await response.json();
assert.equal(tasks.protocolVersion, protocolVersion);
assert.equal(tasks.tasks.length, before.metrics.taskCount);
assert(tasks.cursor >= before.metrics.cursor);

const snapshot = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace('https:', 'wss:')}/api/v3/stream`);
    const timeout = setTimeout(() => { socket.terminate(); reject(new Error('PRODUCTION_SNAPSHOT_TIMEOUT')); }, 15_000);
    let received;
    socket.on('open', () => socket.send(JSON.stringify({ type: 'auth', protocolVersion, token })));
    socket.on('message', raw => {
        try {
            const message = JSON.parse(raw.toString());
            assert.equal(message.protocolVersion, protocolVersion);
            if (message.type === 'authenticated') socket.send(JSON.stringify({ type: 'subscribe', protocolVersion, after: 0 }));
            if (message.type === 'error') throw new Error('PRODUCTION_SUBSCRIPTION_REJECTED');
            if (message.type === 'snapshot') { received = message; socket.close(1000); }
        } catch (error) { socket.terminate(); reject(error); }
    });
    socket.on('error', () => { clearTimeout(timeout); reject(new Error('PRODUCTION_WEBSOCKET_FAILED')); });
    socket.on('close', () => { clearTimeout(timeout); received ? resolve(received) : reject(new Error('PRODUCTION_SNAPSHOT_MISSING')); });
});
assert.equal(snapshot.tasks.length, tasks.tasks.length);
assert(snapshot.cursor >= tasks.cursor);
const traceResponse = await get(`/api/v3/traces/${traceId}?limit=1000`, { headers });
assert.equal(traceResponse.status, 200);
const trace = await traceResponse.json();
assert(trace.spans.some(span => span.parentSpanId === parentSpanId && span.name === 'http.get'));
assert.equal((await get(`/api/v3/traces/${traceId}?limit=0`, { headers })).status, 422);
const after = await (await get('/health')).json();
assert.equal(after.metrics.eventCount, before.metrics.eventCount, 'Business event count changed during read-only acceptance');
assert.equal(after.traceFailedExports, 0);
assert.equal(after.subscribers, before.subscribers, 'Acceptance subscription was not released');
console.log(JSON.stringify({ health: true, authentication: true, snapshot: true, trace: true, validation: true, subscriptionReleased: true, businessWrites: 0, taskCount: tasks.tasks.length, cursor: snapshot.cursor, memoryRssBytes: after.memoryRssBytes }));
