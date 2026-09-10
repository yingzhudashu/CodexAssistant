import type { ActiveFlag, Freshness, LatestTurn, RuntimeStatus, TaskAction, TaskGoalStatus, TaskSnapshot, TaskStatus, TurnStatus } from "@codex-assistant/protocol";

const SECRET = /(?:bearer\s+|(?:api[_-]?key|token|secret|password)\s*[:=]\s*)[A-Za-z0-9._~+\-/=]{8,}/gi;
const KEY_SHAPE = /\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{20,}|AIza[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g;
const WINDOWS_PATH = /(?:[A-Za-z]:\\|\\\\)[^\s"'<>]+/g;
const UNIX_PATH = /\/(?:Users|home|var|tmp|workspace|workspaces|mnt)\/[^\s"'<>]+/gi;

export function sanitizeText(value: unknown, max = 120): string {
  return String(value ?? "")
    .replace(WINDOWS_PATH, "[path]")
    .replace(UNIX_PATH, "[path]")
    .replace(SECRET, "[redacted]")
    .replace(KEY_SHAPE, "[redacted]")
    .replace(/[\r\n\t ]+/g, " ")
    .trim()
    .slice(0, max);
}

export function projectName(cwd: unknown): string | undefined {
  if (typeof cwd !== "string" || !cwd.trim()) return undefined;
  const clean = cwd.replace(/[\\/]+$/, "");
  const name = clean.split(/[\\/]/).filter(Boolean).at(-1);
  return name ? sanitizeText(name, 120) : undefined;
}

export function normalizeStatus(value: unknown): TaskStatus {
  if (value && typeof value === "object") value = (value as { type?: unknown }).type;
  switch (value) {
    case "active": case "running": return "running";
    case "completed": return "completed";
    case "failed": case "systemError": return "failed";
    case "needs_action": return "needs_action";
    default: return "needs_action";
  }
}

export function normalizeRuntimeStatus(value: unknown): RuntimeStatus {
  const raw = value && typeof value === "object" ? (value as { type?: unknown }).type : value;
  if (raw === "notLoaded" || raw === "idle" || raw === "systemError" || raw === "active") return raw;
  return "notLoaded";
}

export function normalizeActiveFlags(value: unknown): ActiveFlag[] {
  const record = value && typeof value === "object" ? value as { activeFlags?: unknown } : {};
  const flags = record.activeFlags;
  if (!Array.isArray(flags)) return [];
  return [...new Set(flags.filter((flag): flag is ActiveFlag => flag === "waitingOnApproval" || flag === "waitingOnUserInput"))].slice(0, 2);
}

export function normalizeTurn(value: unknown): LatestTurn | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const rawStatus = row.status;
  const status: TurnStatus | undefined = rawStatus === "inProgress" || rawStatus === "completed" || rawStatus === "interrupted" || rawStatus === "failed" ? rawStatus : undefined;
  if (!status) return undefined;
  const timestamp = (candidate: unknown): string | undefined => {
    if (typeof candidate === "number" && Number.isFinite(candidate)) return new Date(candidate > 10_000_000_000 ? candidate : candidate * 1000).toISOString();
    if (typeof candidate === "string" && !Number.isNaN(Date.parse(candidate))) return new Date(candidate).toISOString();
    return undefined;
  };
  const startedAt = timestamp(row.startedAt);
  const completedAt = timestamp(row.completedAt);
  const error = row.error && typeof row.error === "object" ? row.error as Record<string, unknown> : undefined;
  return {
    status,
    ...(startedAt ? { startedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
    ...(typeof row.durationMs === "number" && Number.isFinite(row.durationMs) ? { durationMs: Math.max(0, Math.trunc(row.durationMs)) } : {}),
    ...(error ? { error: { code: sanitizeText(error.code || "TURN_FAILED", 80).replace(/[^A-Za-z0-9._:-]/g, "_"), message: sanitizeText(error.message || "执行失败", 200) } } : {}),
  };
}

export function deriveTaskStatus(goal: TaskGoalStatus | undefined, runtime: RuntimeStatus, flags: ActiveFlag[], turn: LatestTurn | undefined): TaskStatus {
  if (runtime === "systemError") return "failed";
  if (flags.length) return "needs_action";
  if (runtime === "active") return "running";
  if (turn?.status === "failed") return "failed";
  if (turn?.status === "interrupted") return "needs_action";
  if (goal && goal !== "running") return goal;
  if (turn?.status === "inProgress") return "running";
  return turn?.status === "completed" ? "completed" : "needs_action";
}

export function normalizeAction(value: unknown): TaskAction | undefined {
  if (typeof value !== "string") return undefined;
  if (/command|shell|terminal/i.test(value)) return "command_execution";
  if (/file|patch|edit|write/i.test(value)) return "file_change";
  if (/mcp|tool/i.test(value)) return "mcp_call";
  if (/message|agent/i.test(value)) return "agent_message";
  return undefined;
}

export function fingerprint(task: TaskSnapshot): string {
  return JSON.stringify(task);
}
