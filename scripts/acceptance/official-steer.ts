import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexAppServer } from '../../apps/desktop/src/app-server.js';
const directory = await mkdtemp(join(tmpdir(), 'codex-steer-acceptance-'));
const report = { initialized: false, startAccepted: false, steersAccepted: 0, sameTurn: true, completed: false, error: '' };
let finish!: () => void;
const done = new Promise<void>(resolve => { finish = resolve; });
const server = new CodexAppServer({
  onNotification: n => { if (n.method === 'turn/completed') { report.completed = (n.params.turn as { status: string }).status === 'completed'; finish(); } },
  onRequest: r => server.respondError(r.id, -32601, 'No tool execution is part of this synthetic message test'),
});
let timer: NodeJS.Timeout | undefined;
try {
  await server.start(); report.initialized = true;
  const t = await server.request('thread/start', { cwd: directory, ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never', config: { model_reasoning_effort: 'low' } }) as { thread: { id: string } };
  const first = await server.startTurn(t.thread.id, 'This is a synthetic message routing test. Do not use tools or inspect files. Reply with a single sentence confirming receipt.') as { turn: { id: string } };
  report.startAccepted = Boolean(first.turn.id);
  for (const text of ['Additional message one: keep the answer brief.', 'Additional message two: include the word RECEIVED.']) {
    const accepted = await server.steerTurn(t.thread.id, first.turn.id, text) as { turnId: string };
    report.steersAccepted++; report.sameTurn &&= accepted.turnId === first.turn.id;
  }
  await Promise.race([done, new Promise<void>((_, reject) => { timer = setTimeout(() => reject(new Error('ACCEPTANCE_TIMEOUT')), 180_000); })]);
} catch (error) { report.error = error instanceof Error ? error.message : 'STEER_FAILED'; }
finally { if (timer) clearTimeout(timer); await server.stop(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); await writeFile('artifacts/acceptance-2026-09-10/official-steer.json', JSON.stringify(report, null, 2) + '\n'); }
console.log(JSON.stringify(report));
if (!report.completed || !report.sameTurn || report.steersAccepted !== 2) process.exitCode = 1;
