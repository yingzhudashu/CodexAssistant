import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const files = [resolve(root, "README.md"), resolve(root, "deploy/README.md"), ...readdirSync(resolve(root, "docs"), { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => resolve(root, "docs", entry.name))];
const errors = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  if (text.includes("\uFEFF")) errors.push(`${file}: UTF-8 BOM is not allowed`);
  if (!text.endsWith("\n")) errors.push(`${file}: missing final newline`);
  for (const target of text.matchAll(/\]\(([^)]+)\)/g)) {
    const local = target[1].split("#", 1)[0];
    if (local && !local.includes("://") && !existsSync(resolve(file, "..", local))) errors.push(`${file}: broken link ${local}`);
  }
}
const readme = readFileSync(resolve(root, "README.md"), "utf8");
const release = readFileSync(resolve(root, "docs/release.zh-CN.md"), "utf8");
const desktop = JSON.parse(readFileSync(resolve(root, "apps/desktop/package.json"), "utf8"));
const androidSource = readFileSync(resolve(root, "android/app/build.gradle.kts"), "utf8");
const android = androidSource.match(/versionName\s*=\s*"([^"]+)"/)?.[1];
const versionCode = androidSource.match(/versionCode\s*=\s*(\d+)/)?.[1];
// 从源码读取版本，升级安装包却未更新文档时必须失败，不能把已发布版本硬编码在检查器中。
for (const version of [desktop.version, android]) {
  if (!version || !readme.includes(version) || !release.includes(version)) errors.push(`README/release docs do not describe client version ${version ?? "missing"}`);
}
if (!versionCode || !readme.includes(`Android versionCode **${versionCode}**`) || !release.includes(`versionCode=${versionCode}`)) errors.push("Android versionCode in README/release docs differs from source");
// 下载链接必须精确匹配各端源码，不能因为正文里仍出现某个旧版本号就误通过。
for (const [version, extension] of [[desktop.version, "exe"], [android, "apk"]]) {
  if (!readme.includes(`/downloads/CodexAssistant-${version}.${extension})`)) errors.push(`README download link differs from ${version}.${extension}`);
}
const protocol = readFileSync(resolve(root, "packages/protocol/src/index.ts"), "utf8").match(/PROTOCOL_VERSION\s*=\s*"([^"]+)"/)?.[1];
const schema = readFileSync(resolve(root, "apps/server/src/database.ts"), "utf8").match(/SCHEMA_VERSION\s*=\s*(\d+)/)?.[1];
if (!protocol || !readme.includes(`\`${protocol}\``) || !release.includes(`\`${protocol}\``)) errors.push("README/release protocol differs from source");
if (!schema || !readme.includes(`schema 为 **${schema}**`)) errors.push("README SQLite schema differs from source");
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/schema (?:当前为|为版本) (\d+)/g)) {
    if (match[1] !== schema) errors.push(`${file}: current SQLite schema ${match[1]} differs from source ${schema}`);
  }
}
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log(`docs: ${files.length} Markdown files checked; local links, download versions, protocol and SQLite schema are valid`);
