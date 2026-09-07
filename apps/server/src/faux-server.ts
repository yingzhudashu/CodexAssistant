import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";

const token = "faux-codex-assistant-token";
const state = mkdtempSync(join(tmpdir(), "codex-assistant-faux-"));
const server = await createApp({ databasePath: join(state, "state.sqlite"), accessToken: token });
await server.app.listen({ host: "127.0.0.1", port: 3240 });
console.log(`Faux ingest server: http://127.0.0.1:3240/codex-assistant (token: ${token})`);
