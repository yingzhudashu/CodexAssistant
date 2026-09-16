import { join } from "node:path";
import { createApp } from "./app.js";

const host = process.env.CODEX_ASSISTANT_HOST ?? "127.0.0.1";
const port = Number(process.env.CODEX_ASSISTANT_PORT ?? "3240");
const stateDirectory =
  process.env.CODEX_ASSISTANT_STATE_DIR ?? "/var/lib/codex-assistant";
const accessToken = process.env.CODEX_ASSISTANT_ACCESS_TOKEN ?? "";

const server = await createApp({
  databasePath: join(stateDirectory, "codex-assistant.sqlite"),
  accessToken,
});
await server.app.listen({ host, port });

const stop = async (): Promise<void> => {
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
