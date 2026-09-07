import type { TaskSnapshot } from "@codex-assistant/protocol";
declare global { interface Window { codexAssistant?: { getConnection(): Promise<{ configured: boolean; apiUrl?: string; deviceId?: string }>; saveConnection(input: { apiUrl: string; token: string }): Promise<unknown>; getTasks(): Promise<TaskSnapshot[]>; getSyncStatus(): Promise<"connecting" | "syncing" | "connected" | "offline">; onTasks(listener: (tasks: TaskSnapshot[]) => void): () => void; onSyncStatus(listener: (status: "connecting" | "syncing" | "connected" | "offline") => void): () => void; }; } }
export {};
