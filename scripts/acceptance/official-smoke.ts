import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServer } from '../../apps/desktop/src/app-server.js';
import { createInteraction, interactionResponse } from '../../apps/desktop/src/interactions.js';

const directory = await mkdtemp(join(tmpdir(), 'codex-official-acceptance-'));
const report: Record<string, unknown> = { initialized: false, requestReceived: false, responseWritten: false, completed: false, notifications: [] as string[] };
let finish: () => void = () => {};
const completed = new Promise<void>(resolve => { finish = resolve; });
const startedAt = Date.now();
report.diagnostics = { stderrLines: 0, signals: [] as string[], events: [] as unknown[] };
const server = new CodexAppServer({
  onLog: line => {
    const d = report.diagnostics as { stderrLines: number; signals: string[] }; d.stderrLines++;
    for (const signal of ["401", "403", "429", "timeout", "connection", "unauthorized", "model_not_found", "error", "failed"])
      if (line.toLowerCase().includes(signal) && !d.signals.includes(signal)) d.signals.push(signal);
  },
  onRequest: rpc => {
    if (rpc.method !== 'item/tool/requestUserInput') { server.respondError(rpc.id, -32601, 'Only synthetic user input is in scope'); return; }
    report.requestReceived = true;
    const pending = createInteraction(rpc)!;
    const answers = Object.fromEntries(pending.request.questions!.map(q => [q.id, { answers: [q.options?.[0]?.label ?? 'Synthetic test answer'] }]));
    server.respond(rpc.id, interactionResponse(pending, { answers }).result);
    report.responseWritten = true;
  },
  onNotification: event => {
    const events = (report.diagnostics as { events: unknown[] }).events;
    if (events.length < 100) events.push({ method: event.method, elapsedMs: Date.now() - startedAt, itemType: (event.params.item as { type?: string } | undefined)?.type, willRetry: event.params.willRetry, errorCode: (event.params.error as { codexErrorInfo?: unknown } | undefined)?.codexErrorInfo });
    const methods = report.notifications as string[]; if (!methods.includes(event.method)) methods.push(event.method);
    if (event.method === 'turn/completed') { report.completed = (event.params.turn as { status?: string }).status === 'completed'; finish(); }
  },
});
let timeout: NodeJS.Timeout | undefined;
try {
  await server.start(); report.initialized = server.ready;
  const started = await server.request('thread/start', { cwd: directory, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true }) as { thread: { id: string }; model: string };
  const model = started.model; report.model = model;
  await server.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'This is an isolated protocol acceptance test. Use request_user_input now to ask one question with two options named Alpha and Beta. Do not call any other tools or inspect files. After receiving the answer, reply only DONE.' }], collaborationMode: { mode: 'plan', settings: { model, reasoning_effort: "low", developer_instructions: null } } });
  await Promise.race([completed, new Promise<void>((_, reject) => { timeout = setTimeout(() => reject(new Error('ACCEPTANCE_TIMEOUT')), 180_000); })]);
} catch (error) { report.error = error instanceof Error ? error.message : 'ACCEPTANCE_FAILED'; }
finally { if (timeout) clearTimeout(timeout); await server.stop(); await writeFile('artifacts/acceptance/official-smoke.json', JSON.stringify(report, null, 2) + '\n'); await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => { report.cleanup = 'temporary directory still locked'; }); }
await writeFile('artifacts/acceptance/official-smoke.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
if (!report.requestReceived || !report.completed) process.exitCode = 1;
