import type { TaskSnapshot } from "@codex-assistant/protocol";
declare global {
  interface Window {
    codexAssistant?: {
      getConnection(): Promise<{
        configured: boolean;
        apiUrl?: string;
        deviceId?: string;
      }>;
      saveConnection(input: {
        apiUrl: string;
        token: string;
      }): Promise<unknown>;
      getTasks(): Promise<TaskSnapshot[]>;
      getSyncStatus(): Promise<
        "connecting" | "syncing" | "connected" | "offline"
      >;
      getWorkstationStatus(): Promise<{ ready: boolean }>;
      getTaskDetail(input: {
        threadId: string;
        cursor?: string;
      }): Promise<{ turns: unknown[]; cursor?: string }>;
      sendTaskMessage(input: {
        threadId: string;
        text: string;
      }): Promise<{ status: string }>;
      checkUpdate(): Promise<{
        currentVersion: string;
        latestVersion: string;
        available: boolean;
        windowsUrl?: string;
        androidUrl?: string;
      }>;
      downloadUpdate(
        target: "windows" | "android",
      ): Promise<{ opened: boolean }>;
      onTasks(listener: (tasks: TaskSnapshot[]) => void): () => void;
      onSyncStatus(
        listener: (
          status: "connecting" | "syncing" | "connected" | "offline",
        ) => void,
      ): () => void;
    };
  }
}
export {};
