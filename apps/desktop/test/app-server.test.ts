import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { CodexAppServer } from '../src/app-server.js';

const state = vi.hoisted(() => ({ child: undefined as any }));
vi.mock('node:child_process', () => ({ spawn: () => {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null, kill() { this.exitCode = 0; this.emit('exit', 0, null); return true; } });
  state.child = child;
  return child;
} }));

it('does not resolve an outgoing RPC with a server request that reuses its numeric ID', async () => {
  const onRequest = vi.fn();
  const server = new CodexAppServer({ onRequest });
  let initialized = false;
  const starting = server.start().then(() => { initialized = true; });
  try {
    state.child.stdout.write(JSON.stringify({ id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'synthetic' } }) + '\n');
    await Promise.resolve(); await Promise.resolve();
    expect(onRequest).toHaveBeenCalledWith({ id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'synthetic' } });
    expect(initialized).toBe(false);
    expect(server.ready).toBe(false);
    state.child.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
    await starting;
    expect(server.ready).toBe(true);
  } finally { await server.stop(); }
});
