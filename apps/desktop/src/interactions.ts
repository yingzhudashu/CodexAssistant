import { randomUUID } from "node:crypto";
import {
  InteractionRequestSchema,
  parseStrict,
  type InteractionRequest,
  type InteractionQuestion,
} from "@codex-assistant/protocol";
import { Value } from "typebox/value";
import type { TSchema } from "typebox";
import type { AppServerRequest } from "./app-server.js";

const record = (v: unknown): Record<string, any> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, any>)
    : {};
const text = (v: unknown, otherwise: string): string =>
  typeof v === "string" && v.length ? v : otherwise;
const labels: Record<string, string> = {
  accept: "允许本次",
  decline: "拒绝本次",
  cancel: "取消回合",
  acceptForSession: "允许本会话",
  acceptWithExecpolicyAmendment: "允许并保存命令规则",
  applyNetworkPolicyAmendment: "应用网络规则",
};
export type PendingInteraction = {
  rpc: AppServerRequest;
  request: InteractionRequest;
  decisions: Map<string, unknown>;
};

/** 官方RPC差异集中于本适配器；中转和界面仅使用统一表单模型。 */
export function createInteraction(
  rpc: AppServerRequest,
): PendingInteraction | undefined {
  const p = rpc.params;
  if (typeof p.threadId !== "string") return undefined;
  const request: {
    -readonly [K in keyof InteractionRequest]: InteractionRequest[K];
  } = {
    type: "interaction.request",
    protocolVersion: "codex-assistant.v3",
    requestId: randomUUID(),
    threadId: p.threadId,
    kind: "unsupported",
    title: "此请求需要在工作站处理",
    description: `当前客户端不支持 ${rpc.method}`,
  };
  const decisions = new Map<string, unknown>();
  try {
    if (rpc.method === "item/tool/requestUserInput") {
      if (!Array.isArray(p.questions) || !p.questions.length)
        throw new Error("QUESTIONS_INVALID");
      request.questions = p.questions.map((v): InteractionQuestion => {
        const q = record(v);
        if (
          typeof q.id !== "string" ||
          typeof q.header !== "string" ||
          typeof q.question !== "string"
        )
          throw new Error("QUESTION_INVALID");
        return {
          id: q.id,
          header: q.header,
          question: q.question,
          required: true,
          multiple: false,
          isOther: true,
          isSecret: q.isSecret === true,
          ...(Array.isArray(q.options)
            ? {
                options: q.options.map((v: unknown, i: number) => {
                  const o = record(v);
                  return {
                    id: `option-${i}`,
                    label: o.label,
                    ...(o.description ? { description: o.description } : {}),
                  };
                }),
              }
            : {}),
        };
      });
      request.kind = request.questions.some((q) => q.options?.length)
        ? "single_select"
        : "text";
      request.title = "Codex 需要你的回答";
      delete request.description;
    } else if (
      rpc.method === "item/commandExecution/requestApproval" ||
      rpc.method === "item/fileChange/requestApproval" ||
      rpc.method === "item/permissions/requestApproval"
    ) {
      request.kind = "confirm";
      request.title =
        rpc.method === "item/fileChange/requestApproval"
          ? "确认文件修改权限"
          : rpc.method === "item/permissions/requestApproval"
            ? "确认本回合权限范围"
            : "确认命令执行";
      request.description =
        [
          p.command,
          p.cwd,
          p.reason,
          p.grantRoot,
          p.permissions ? JSON.stringify(p.permissions) : undefined,
          p.additionalPermissions
            ? JSON.stringify(p.additionalPermissions)
            : undefined,
        ]
          .filter((v) => typeof v === "string" && v.length)
          .join("\n") ||
        `文件或操作 ${text(p.itemId, "未提供")}；未提供进一步说明`;
      const values = Array.isArray(p.availableDecisions)
        ? p.availableDecisions
        : ["accept", "decline", "cancel"];
      request.options = values.map((value, i) => {
        const key =
          typeof value === "string" ? value : Object.keys(record(value))[0];
        if (!labels[key]) throw new Error("DECISION_UNSUPPORTED");
        const id = typeof value === "string" ? value : `decision-${i}`;
        decisions.set(id, value);
        return {
          id,
          label: labels[key],
          ...(typeof value === "object"
            ? { description: JSON.stringify(value) }
            : {}),
        };
      });
    } else if (
      rpc.method === "mcpServer/elicitation/request" &&
      p.mode === "form"
    ) {
      const schema = record(p.requestedSchema);
      if (schema.type !== "object") throw new Error("FORM_UNSUPPORTED");
      request.questions = Object.entries(record(schema.properties)).map(
        ([id, v]): InteractionQuestion => {
          const field = record(v);
          if (
            field.format ||
            !["string", "array", "boolean"].includes(field.type)
          )
            throw new Error("FIELD_UNSUPPORTED");
          const choices = field.type === "array" ? record(field.items) : field;
          const enums =
            field.type === "boolean" ? ["true", "false"] : choices.enum;
          const titled = choices.oneOf ?? choices.anyOf;
          const options = Array.isArray(enums)
            ? enums.map((label, i) => ({
                id: `option-${i}`,
                label: String(label),
              }))
            : Array.isArray(titled)
              ? titled.map((v, i) => ({
                  id: `option-${i}`,
                  label: String(record(v).const),
                  description: String(record(v).title),
                }))
              : undefined;
          if (field.type === "array" && !options)
            throw new Error("ARRAY_UNSUPPORTED");
          return {
            id,
            header: text(field.title, id),
            question: text(field.description, text(field.title, id)),
            required:
              Array.isArray(schema.required) && schema.required.includes(id),
            multiple: field.type === "array",
            isOther: false,
            isSecret: false,
            ...(options ? { options } : {}),
          };
        },
      );
      request.kind = request.questions.some((q) => q.multiple)
        ? "multi_select"
        : request.questions.some((q) => q.options?.length)
          ? "single_select"
          : "text";
      request.title = text(p.message, "工具需要你的回答");
      delete request.description;
    }
    if (
      !parseStrict(InteractionRequestSchema, request) ||
      new Set(request.questions?.map((q) => q.id)).size !==
        (request.questions?.length ?? 0) ||
      Buffer.byteLength(JSON.stringify(request)) > 28 * 1024
    )
      throw new Error("REQUEST_LIMIT");
  } catch {
    request.kind = "unsupported";
    request.title = "此请求暂时无法在当前客户端处理";
    request.description = `请求类型或大小超出支持范围：${rpc.method}。可取消后在工作站重新发起。`;
    delete request.questions;
    delete request.options;
    decisions.clear();
  }
  return { rpc, request, decisions };
}

export function interactionResponse(
  pending: PendingInteraction,
  value: unknown,
): { result?: unknown; cancel: boolean; unsupported?: boolean } {
  const v = record(value),
    { rpc, request } = pending;
  const cancel = v.cancel === true;
  if (cancel) {
    if (Object.keys(v).length !== 1) throw new Error("ANSWER_INVALID");
    if (rpc.method === "item/tool/requestUserInput")
      return { result: { answers: {} }, cancel };
    if (rpc.method === "mcpServer/elicitation/request")
      return { result: { action: "cancel" }, cancel };
    if (rpc.method === "item/permissions/requestApproval")
      return { result: { permissions: {}, scope: "turn" }, cancel };
    if (
      rpc.method === "item/commandExecution/requestApproval" ||
      rpc.method === "item/fileChange/requestApproval"
    )
      return { result: { decision: "cancel" }, cancel };
    return { cancel, unsupported: true };
  }
  if (request.kind === "unsupported") throw new Error("REQUEST_UNSUPPORTED");
  if (request.kind === "confirm") {
    if (
      Object.keys(v).length !== 1 ||
      typeof v.decision !== "string" ||
      !pending.decisions.has(v.decision)
    )
      throw new Error("DECISION_INVALID");
    const decision = pending.decisions.get(v.decision);
    if (rpc.method === "item/permissions/requestApproval")
      return {
        result: {
          permissions: decision === "accept" ? rpc.params.permissions : {},
          scope: "turn",
        },
        cancel: decision === "cancel",
      };
    return { result: { decision }, cancel: decision === "cancel" };
  }
  if (
    Object.keys(v).length !== 1 ||
    !v.answers ||
    typeof v.answers !== "object"
  )
    throw new Error("ANSWERS_INVALID");
  const content: Record<string, unknown> = Object.create(null);
  const answers = record(v.answers),
    fields = request.questions ?? [];
  if (Object.keys(answers).some((id) => !fields.some((q) => q.id === id)))
    throw new Error("UNKNOWN_QUESTION");
  for (const q of fields) {
    const entry = record(answers[q.id]),
      selected = entry.answers;
    if (!selected && !q.required) continue;
    if (
      Object.keys(entry).length !== 1 ||
      !Array.isArray(selected) ||
      selected.some((x) => typeof x !== "string" || x.length > 20_000) ||
      (q.required && (!selected.length || selected.some((x) => !x.trim()))) ||
      (!q.multiple && selected.length > 1) ||
      new Set(selected).size !== selected.length
    )
      throw new Error("ANSWER_INVALID");
    // 原生用户输入允许自由文本；MCP枚举答案则必须落在声明范围内。
    if (
      rpc.method === "mcpServer/elicitation/request" &&
      q.options?.length &&
      selected.some((x) => !q.options!.some((o) => o.label === x))
    )
      throw new Error("OPTION_INVALID");
    const field = record(
      record(record(rpc.params.requestedSchema).properties)[q.id],
    );
    content[q.id] = q.multiple
      ? selected
      : field.type === "boolean"
        ? selected[0] === "true"
        : selected[0];
  }
  if (rpc.method === "mcpServer/elicitation/request") {
    if (!Value.Check(rpc.params.requestedSchema as TSchema, content))
      throw new Error("FORM_CONSTRAINT_FAILED");
    return { result: { action: "accept", content }, cancel: false };
  }
  return { result: { answers }, cancel: false };
}
