import { expect, it } from 'vitest';
import { createInteraction, interactionResponse } from '../src/interactions.js';
import { InteractionRequestSchema, parseStrict } from '@codex-assistant/protocol';

const input = () => createInteraction({ id: 1, method: 'item/tool/requestUserInput', params: { threadId: 'thread', turnId: 'turn', itemId: 'item', isBlocking: true, questions: [
  { id: 'plan', header: 'Plan', question: 'Choose the execution plan', options: [{ label: 'Implement', description: 'Proceed' }, { label: 'Revise', description: 'Edit' }] },
  { id: 'secret', header: 'Secret', question: 'Enter text', isSecret: true, options: null },
] } })!;

it('validates all questions together, retains official labels, and rejects booleans or partial answers', () => {
  const pending = input();
  expect(parseStrict(InteractionRequestSchema, pending.request)).toBeDefined();
  expect(pending.request.questions?.[1].isSecret).toBe(true);
  const value = { answers: { plan: { answers: ['Implement'] }, secret: { answers: ['test text'] } } };
  expect(interactionResponse(pending, value)).toEqual({ result: value, cancel: false });
  expect(() => interactionResponse(pending, { answers: { plan: { answers: ['Implement'] } } })).toThrow();
  expect(() => interactionResponse(pending, true)).toThrow();
  expect(interactionResponse(pending, { cancel: true })).toEqual({ result: { answers: {} }, cancel: true });
});

it('supports native MCP multi-select and enforces original schema constraints', () => {
  const pending = createInteraction({ id: 'mcp', method: 'mcpServer/elicitation/request', params: { threadId: 'thread', serverName: 'test', mode: 'form', message: 'Choose features', requestedSchema: { type: 'object', required: ['features'], properties: { features: { type: 'array', minItems: 2, maxItems: 3, items: { type: 'string', enum: ['A', 'B', 'C'] } }, note: { type: 'string', maxLength: 20 } } } } })!;
  expect(pending.request.kind).toBe('multi_select');
  expect(pending.request.questions?.[0].multiple).toBe(true);
  expect(interactionResponse(pending, { answers: { features: { answers: ['A', 'B'] }, note: { answers: ['hello'] } } })).toEqual({ cancel: false, result: { action: 'accept', content: { features: ['A', 'B'], note: 'hello' } } });
  expect(() => interactionResponse(pending, { answers: { features: { answers: ['A'] } } })).toThrow('FORM_CONSTRAINT_FAILED');
  expect(() => interactionResponse(pending, { answers: { features: { answers: ['A', 'invalid'] } } })).toThrow('OPTION_INVALID');
});

it('uses only offered approval decisions and preserves structured decisions', () => {
  const amended = { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['echo'] } };
  const pending = createInteraction({ id: 2, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', command: 'echo test', availableDecisions: ['decline', amended] } })!;
  expect(pending.request.description).toContain('echo test');
  expect(() => interactionResponse(pending, { decision: 'accept' })).toThrow('DECISION_INVALID');
  expect(interactionResponse(pending, { decision: 'decision-1' }).result).toEqual({ decision: amended });
});

it('grants only the requested permissions for the current turn', () => {
  const permissions = { network: { enabled: true } };
  const pending = createInteraction({ id: 3, method: 'item/permissions/requestApproval', params: { threadId: 'thread', permissions } })!;
  expect(interactionResponse(pending, { decision: 'accept' }).result).toEqual({ permissions, scope: 'turn' });
  expect(interactionResponse(pending, { cancel: true }).result).toEqual({ permissions: {}, scope: 'turn' });
});

it('exposes unsupported methods and oversize requests without silently truncating question IDs', () => {
  const pending = createInteraction({ id: 4, method: 'unknown/method', params: { threadId: 'thread' } })!;
  expect(pending.request.kind).toBe('unsupported');
  expect(() => interactionResponse(pending, { answers: {} })).toThrow();
  expect(interactionResponse(pending, { cancel: true }).unsupported).toBe(true);
  const long = input(); long.rpc.params.questions = [{ id: 'x'.repeat(300), header: 'Test', question: 'Test' }];
  expect(createInteraction(long.rpc)?.request.kind).toBe('unsupported');
});
