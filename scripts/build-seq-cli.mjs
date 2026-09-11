/**
 * 打包测试序列器 CLI（T5）：scripts/seq-cli.ts → dist-cli/uartix-seq.cjs
 * esbuild 来自 vite 的传递依赖，无需新增安装项。
 * 运行：npm run build:seq && node dist-cli/uartix-seq.cjs --help
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist-cli", { recursive: true });
await build({
  entryPoints: ["scripts/seq-cli.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "dist-cli/uartix-seq.cjs",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});
process.stdout.write("dist-cli/uartix-seq.cjs OK\n");
