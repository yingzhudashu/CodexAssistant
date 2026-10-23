import { expect, it } from "vitest";
import { Value } from "typebox/value";
import {
  ClientWebSocketMessageSchema,
  TraceSpanReceiptSchema,
  parseStrict,
} from "@codex-assistant/protocol";

it("keeps compiled validation as strict as the schema interpreter", () => {
  const valid = {
    type: "auth",
    protocolVersion: "codex-assistant.v3",
    token: "synthetic-token-long-enough",
  };
  const cases = [
    valid,
    { ...valid, extra: true },
    { ...valid, protocolVersion: "old" },
    { ...valid, token: 1 },
    { ...valid, token: "" },
    null,
    [],
    {},
    { type: "subscribe", protocolVersion: "codex-assistant.v3", after: -1 },
  ];
  for (const value of cases)
    expect(Boolean(parseStrict(ClientWebSocketMessageSchema, value))).toBe(
      Value.Check(ClientWebSocketMessageSchema, value),
    );
  for (const value of [
    { accepted: true, count: 2 },
    { accepted: false, count: 2 },
    { accepted: true, count: 0 },
    { accepted: true, count: 2.1 },
    { accepted: true, count: 2, extra: true },
  ]) {
    expect(Boolean(parseStrict(TraceSpanReceiptSchema, value))).toBe(
      Value.Check(TraceSpanReceiptSchema, value),
    );
  }
});
