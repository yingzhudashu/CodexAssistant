import Type, { type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";

export const PROTOCOL_VERSION = "codex-assistant.v3" as const;

const Strict = <const T extends Parameters<typeof Type.Object>[0]>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const IsoTimestamp = Type.String({ minLength: 20, maxLength: 40 });
const Identifier = Type.String({ minLength: 1, maxLength: 200, pattern: "^[A-Za-z0-9._:-]+$" });
const SafeText = Type.String({ minLength: 1, maxLength: 500 });
const TraceId = Type.String({ minLength: 32, maxLength: 32, pattern: "^[a-f0-9]{32}$" });
const SpanId = Type.String({ minLength: 16, maxLength: 16, pattern: "^[a-f0-9]{16}$" });

/**
 * 跨桌面端、服务端和 Android 的最小追踪上下文。
 * ID 只允许小写十六进制，既方便日志检索，也避免把任意文本带入协议。
 */
export const TraceContextSchema = Strict({
  traceId: TraceId,
  spanId: SpanId,
  parentSpanId: Type.Optional(SpanId),
});
export type TraceContext = Static<typeof TraceContextSchema>;

export const TraceSpanSchema = Strict({
  traceId: TraceId,
  spanId: SpanId,
  parentSpanId: Type.Optional(SpanId),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  startedAt: IsoTimestamp,
  endedAt: IsoTimestamp,
  attributes: Type.Optional(Type.Record(Type.String({ maxLength: 40 }), Type.String({ maxLength: 200 }), { maxProperties: 20 })),
});
export type TraceSpan = Static<typeof TraceSpanSchema>;

export const TaskStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("needs_action"),
  Type.Literal("completed"),
  Type.Literal("failed"),
]);
export type TaskStatus = Static<typeof TaskStatusSchema>;

export const RuntimeStatusSchema = Type.Union([
  Type.Literal("notLoaded"),
  Type.Literal("idle"),
  Type.Literal("systemError"),
  Type.Literal("active"),
]);
export type RuntimeStatus = Static<typeof RuntimeStatusSchema>;

export const ActiveFlagSchema = Type.Union([
  Type.Literal("waitingOnApproval"),
  Type.Literal("waitingOnUserInput"),
]);
export type ActiveFlag = Static<typeof ActiveFlagSchema>;

export const TurnStatusSchema = Type.Union([
  Type.Literal("inProgress"),
  Type.Literal("completed"),
  Type.Literal("interrupted"),
  Type.Literal("failed"),
]);
export type TurnStatus = Static<typeof TurnStatusSchema>;

export const FreshnessSchema = Type.Union([
  Type.Literal("fresh"),
  Type.Literal("stale"),
  Type.Literal("unavailable"),
]);
export type Freshness = Static<typeof FreshnessSchema>;

export const TaskErrorSchema = Strict({
  code: Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9._:-]+$" }),
  message: SafeText,
});
export type TaskError = Static<typeof TaskErrorSchema>;

export const LatestTurnSchema = Strict({
  status: TurnStatusSchema,
  startedAt: Type.Optional(IsoTimestamp),
  completedAt: Type.Optional(IsoTimestamp),
  durationMs: Type.Optional(Type.Integer({ minimum: 0 })),
  error: Type.Optional(TaskErrorSchema),
});
export type LatestTurn = Static<typeof LatestTurnSchema>;

export const TaskActionSchema = Type.Union([
  Type.Literal("command_execution"),
  Type.Literal("file_change"),
  Type.Literal("mcp_call"),
  Type.Literal("agent_message"),
]);
export type TaskAction = Static<typeof TaskActionSchema>;

export const PlanStepSchema = Strict({
  id: Identifier,
  title: SafeText,
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("in_progress"),
    Type.Literal("completed"),
    Type.Literal("failed"),
  ]),
});
export type PlanStep = Static<typeof PlanStepSchema>;

export const TaskGoalStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("needs_action"),
  Type.Literal("completed"),
  Type.Literal("failed"),
]);
export type TaskGoalStatus = Static<typeof TaskGoalStatusSchema>;

export const TaskGoalSchema = Strict({
  objective: SafeText,
  status: TaskGoalStatusSchema,
  timeUsedSeconds: Type.Integer({ minimum: 0 }),
  tokensUsed: Type.Integer({ minimum: 0 }),
  tokenBudget: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type TaskGoal = Static<typeof TaskGoalSchema>;

export const TaskSnapshotSchema = Strict({
  id: Identifier,
  title: Type.String({ minLength: 1, maxLength: 120 }),
  projectName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
  status: TaskStatusSchema,
  runtimeStatus: RuntimeStatusSchema,
  activeFlags: Type.Array(ActiveFlagSchema, { maxItems: 2 }),
  freshness: FreshnessSchema,
  source: Type.Union([Type.Literal("goal"), Type.Literal("thread")]),
  goal: Type.Optional(TaskGoalSchema),
  latestTurn: Type.Optional(LatestTurnSchema),
  error: Type.Optional(TaskErrorSchema),
  plan: Type.Array(PlanStepSchema, { maxItems: 100 }),
  currentStepId: Type.Optional(Identifier),
  action: Type.Optional(TaskActionSchema),
  updatedAt: IsoTimestamp,
  changedAt: IsoTimestamp,
});
export type TaskSnapshot = Static<typeof TaskSnapshotSchema>;

export const IngestEventSchema = Strict({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  deviceId: Identifier,
  localSequence: Type.Integer({ minimum: 1 }),
  occurredAt: IsoTimestamp,
  trace: TraceContextSchema,
  task: TaskSnapshotSchema,
});
export type IngestEvent = Static<typeof IngestEventSchema>;

export const ServerEventSchema = Strict({
  sequence: Type.Integer({ minimum: 1 }),
  deviceId: Identifier,
  localSequence: Type.Integer({ minimum: 1 }),
  occurredAt: IsoTimestamp,
  trace: TraceContextSchema,
  task: TaskSnapshotSchema,
});
export type ServerEvent = Static<typeof ServerEventSchema>;

export const IngestResponseSchema = Strict({
  accepted: Type.Boolean(),
  duplicate: Type.Boolean(),
  sequence: Type.Integer({ minimum: 1 }),
});
export type IngestResponse = Static<typeof IngestResponseSchema>;

export const TraceSpanBatchSchema = Strict({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  spans: Type.Array(TraceSpanSchema, { minItems: 1, maxItems: 100 }),
});
export type TraceSpanBatch = Static<typeof TraceSpanBatchSchema>;

export const TasksResponseSchema = Strict({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  cursor: Type.Integer({ minimum: 0 }),
  tasks: Type.Array(TaskSnapshotSchema),
});
export type TasksResponse = Static<typeof TasksResponseSchema>;

export const ErrorCodeSchema = Type.Union([
  Type.Literal("auth_required"),
  Type.Literal("protocol_unsupported"),
  Type.Literal("validation_failed"),
  Type.Literal("schema_mismatch"),
  Type.Literal("internal_error"),
  Type.Literal("trace_not_found"),
]);
export type ErrorCode = Static<typeof ErrorCodeSchema>;

export const ErrorMessageSchema = Strict({
  type: Type.Literal("error"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  code: ErrorCodeSchema,
  message: Type.String({ minLength: 1, maxLength: 200 }),
});
export type ErrorMessage = Static<typeof ErrorMessageSchema>;

export const ClientAuthMessageSchema = Strict({
  type: Type.Literal("auth"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  token: Type.String({ minLength: 16, maxLength: 4096 }),
});
export type ClientAuthMessage = Static<typeof ClientAuthMessageSchema>;

export const ClientSubscribeMessageSchema = Strict({
  type: Type.Literal("subscribe"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  after: Type.Integer({ minimum: 0 }),
});
export type ClientSubscribeMessage = Static<typeof ClientSubscribeMessageSchema>;

export const ClientDetailMessageSchema = Strict({
  type: Type.Literal("detail"), protocolVersion: Type.Literal(PROTOCOL_VERSION), requestId: Identifier, threadId: Identifier,
  cursor: Type.Optional(Type.String({ maxLength: 500 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
});
export type ClientDetailMessage = Static<typeof ClientDetailMessageSchema>;
export const ClientSendMessageSchema = Strict({
  type: Type.Literal("send"), protocolVersion: Type.Literal(PROTOCOL_VERSION), requestId: Identifier,
  threadId: Identifier, text: Type.String({ minLength: 1, maxLength: 20_000 }),
});
export type ClientSendMessage = Static<typeof ClientSendMessageSchema>;
export const InteractionOptionSchema = Strict({ id: Identifier, label: SafeText, description: Type.Optional(SafeText) });
export const InteractionKindSchema = Type.Union([Type.Literal("single_select"), Type.Literal("multi_select"), Type.Literal("confirm"), Type.Literal("text"), Type.Literal("plan_select"), Type.Literal("unsupported")]);
export const InteractionQuestionSchema = Strict({
  id: Type.String({ minLength: 1, maxLength: 200 }),
  header: SafeText,
  question: SafeText,
  required: Type.Boolean(),
  multiple: Type.Boolean(),
  isSecret: Type.Optional(Type.Boolean()),
  isOther: Type.Optional(Type.Boolean()),
  options: Type.Optional(Type.Array(InteractionOptionSchema, { maxItems: 100 })),
});
export type InteractionQuestion = Static<typeof InteractionQuestionSchema>;
export const InteractionRequestSchema = Strict({
  type: Type.Literal("interaction.request"), protocolVersion: Type.Literal(PROTOCOL_VERSION), requestId: Identifier, threadId: Identifier,
  kind: InteractionKindSchema, title: SafeText, description: Type.Optional(SafeText), options: Type.Optional(Type.Array(InteractionOptionSchema, { maxItems: 100 })),
  questions: Type.Optional(Type.Array(InteractionQuestionSchema, { maxItems: 100 })),
  expiresAt: Type.Optional(IsoTimestamp),
});
export type InteractionRequest = Static<typeof InteractionRequestSchema>;
export const InteractionSubmitMessageSchema = Strict({ type: Type.Literal("interaction.submit"), protocolVersion: Type.Literal(PROTOCOL_VERSION), requestId: Identifier, threadId: Identifier, value: Type.Unknown() });
export type InteractionSubmitMessage = Static<typeof InteractionSubmitMessageSchema>;
export const InteractionResultSchema = Strict({ type: Type.Literal("interaction.result"), protocolVersion: Type.Literal(PROTOCOL_VERSION), requestId: Identifier, threadId: Identifier, status: Type.Union([Type.Literal("submitted"), Type.Literal("cancelled"), Type.Literal("expired"), Type.Literal("failed")]), value: Type.Optional(Type.Unknown()), error: Type.Optional(Type.String({ maxLength: 500 })) });
export type InteractionResult = Static<typeof InteractionResultSchema>;
export const DetailMessageSchema = Strict({
  type: Type.Literal("detail"), protocolVersion: Type.Literal(PROTOCOL_VERSION), requestId: Identifier, threadId: Identifier,
  turns: Type.Array(Type.Unknown(), { maxItems: 50 }), cursor: Type.Optional(Type.String({ maxLength: 500 })),
});
export type DetailMessage = Static<typeof DetailMessageSchema>;
export const ResultMessageSchema = Strict({
  type: Type.Literal("result"), protocolVersion: Type.Literal(PROTOCOL_VERSION), requestId: Identifier,
  threadId: Identifier, status: Type.Union([Type.Literal("started"), Type.Literal("streaming"), Type.Literal("completed"), Type.Literal("failed")]),
  text: Type.Optional(Type.String({ maxLength: 20_000 })), error: Type.Optional(Type.String({ maxLength: 500 })),
});
export type ResultMessage = Static<typeof ResultMessageSchema>;

export const ClientWebSocketMessageSchema = Type.Union([ClientAuthMessageSchema, ClientSubscribeMessageSchema, ClientDetailMessageSchema, ClientSendMessageSchema, InteractionSubmitMessageSchema]);
export type ClientWebSocketMessage = Static<typeof ClientWebSocketMessageSchema>;

export const AuthenticatedMessageSchema = Strict({
  type: Type.Literal("authenticated"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
});
export type AuthenticatedMessage = Static<typeof AuthenticatedMessageSchema>;

export const EventMessageSchema = Strict({
  type: Type.Literal("event"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  event: ServerEventSchema,
});
export type EventMessage = Static<typeof EventMessageSchema>;

export const SnapshotMessageSchema = Strict({
  type: Type.Literal("snapshot"),
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  cursor: Type.Integer({ minimum: 0 }),
  tasks: Type.Array(TaskSnapshotSchema),
});
export type SnapshotMessage = Static<typeof SnapshotMessageSchema>;

export const TraceResponseSchema = Strict({
  protocolVersion: Type.Literal(PROTOCOL_VERSION),
  traceId: TraceId,
  spans: Type.Array(TraceSpanSchema, { maxItems: 1000 }),
});
export type TraceResponse = Static<typeof TraceResponseSchema>;

export const ServerWebSocketMessageSchema = Type.Union([
  AuthenticatedMessageSchema,
  EventMessageSchema,
  SnapshotMessageSchema,
  ErrorMessageSchema,
  DetailMessageSchema,
  ResultMessageSchema,
  InteractionRequestSchema,
  InteractionResultSchema,
]);
export type ServerWebSocketMessage = Static<typeof ServerWebSocketMessageSchema>;

export function parseStrict<T>(schema: TSchema, value: unknown): T | undefined {
  return Value.Check(schema, value) ? (value as T) : undefined;
}

export function protocolError(code: ErrorCode, message: string): ErrorMessage {
  return { type: "error", protocolVersion: PROTOCOL_VERSION, code, message };
}
