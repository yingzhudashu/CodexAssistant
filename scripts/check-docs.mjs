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
if (errors.length) { console.error(errors.join("\n")); process.exit(1); }
console.log(`docs: ${files.length} Markdown files checked; local links and current client version references are valid`);
