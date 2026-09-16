import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, safeStorage } from "electron";

type StoredConnection = {
  version: 2;
  apiUrl: string;
  encryptedToken: string;
  deviceId: string;
};
export type DesktopConnection = {
  configured: boolean;
  apiUrl?: string;
  token?: string;
  deviceId?: string;
};

function configPath(): string {
  return join(app.getPath("userData"), "connection.json");
}
function validateApiUrl(value: string): string {
  const url = new URL(value.trim());
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    url.hostname,
  );
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("DESKTOP_ROOT_URL_REQUIRED");
  return url.toString().replace(/\/$/, "");
}
export async function loadDesktopConnection(): Promise<DesktopConnection> {
  try {
    const stored = JSON.parse(
      await readFile(configPath(), "utf8"),
    ) as StoredConnection;
    if (
      stored.version !== 2 ||
      typeof stored.apiUrl !== "string" ||
      typeof stored.encryptedToken !== "string" ||
      typeof stored.deviceId !== "string"
    )
      throw new Error("DESKTOP_CONNECTION_INVALID");
    if (!safeStorage.isEncryptionAvailable())
      throw new Error("DESKTOP_KEYSTORE_UNAVAILABLE");
    return {
      configured: true,
      apiUrl: validateApiUrl(stored.apiUrl),
      token: safeStorage.decryptString(
        Buffer.from(stored.encryptedToken, "base64"),
      ),
      deviceId: stored.deviceId,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { configured: false };
    throw error;
  }
}
export async function saveDesktopConnection(input: {
  apiUrl: string;
  token: string;
}): Promise<DesktopConnection> {
  const apiUrl = validateApiUrl(input.apiUrl);
  const token = input.token.trim();
  if (token.length < 16 || token.length > 4096)
    throw new Error("DESKTOP_TOKEN_INVALID");
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("DESKTOP_KEYSTORE_UNAVAILABLE");
  let deviceId: string = randomUUID();
  try {
    const current = await loadDesktopConnection();
    deviceId = current.deviceId ?? deviceId;
  } catch (error) {
    const invalid =
      error instanceof Error &&
      (error.message === "DESKTOP_CONNECTION_INVALID" ||
        error.name === "SyntaxError");
    if (!invalid) throw error;
    // 旧版本或损坏配置不参与迁移，直接删除；随后只写入当前 v2 格式。
    await rm(configPath(), { force: true });
  }
  const path = configPath();
  const temporary = `${path}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ version: 2, apiUrl, encryptedToken: safeStorage.encryptString(token).toString("base64"), deviceId })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  return { configured: true, apiUrl, token, deviceId };
}
