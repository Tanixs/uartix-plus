/**
 * 打包 MCP 桥 CLI（P64c）：scripts/mcp-cli.ts → dist-cli/uartix-mcp.cjs
 * esbuild 来自 vite 的传递依赖，无需新增安装项。
 * 运行：npm run build:mcp && node dist-cli/uartix-mcp.cjs --help
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";

mkdirSync("dist-cli", { recursive: true });
await build({
  entryPoints: ["scripts/mcp-cli.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  outfile: "dist-cli/uartix-mcp.cjs",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});
process.stdout.write("dist-cli/uartix-mcp.cjs OK\n");
