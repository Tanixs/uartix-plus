/**
 * 打包命令行插件工具（P99c-C1b）：scripts/plugin-cli.ts → dist-cli/uartix-plugin.cjs
 * 与 build-mcp-cli 同形：esbuild 是 vite 的传递依赖，不新增安装项。
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist-cli", { recursive: true });
await build({
  entryPoints: ["scripts/plugin-cli.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "dist-cli/uartix-plugin.cjs",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});
process.stdout.write("dist-cli/uartix-plugin.cjs OK\n");
