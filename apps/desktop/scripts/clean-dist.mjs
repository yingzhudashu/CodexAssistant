import { rm } from "node:fs/promises";
import { resolve } from "node:path";

// TypeScript 输出和 electron-builder 输出不能共用旧文件，否则旧的 win-unpacked
// 会被递归打进 app.asar，导致安装包膨胀并拖慢启动。
await Promise.all([
  rm(resolve("dist"), { recursive: true, force: true }),
  rm(resolve("tsconfig.tsbuildinfo"), { force: true }),
]);
