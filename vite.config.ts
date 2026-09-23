import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// P99b-N5 自检锚点：本文件必须能被 vitest 的 esbuild 解析（BOM 会让它整份配置静默失效）

/**
 * P99b-N5：测试环境下的 `*.css?raw` 装载。
 *
 * 为什么要它：内置主题这八份文件从"运行时样式表"改成"数据"（`?raw` 读进来自己解析，详设 S2），
 * 而 vitest 默认 `css:false` 会把 **所有** CSS 导入 stub 成空串——于是八枚内置主题在测试里
 * 静默变成八张空表，themeCore/装载层的守卫全部对着空数据点头（实测：`?raw` 拿到长度 0）。
 * 开发/构建走 Vite 原生 `?raw`，这里只在 vitest 下补一条同语义的读取（读的是同一批字节，不复制数值）。
 *
 * `order: "post"` 是必要的：`vite:css-post` 在插件表的更后面，会把前面的结果再 stub 一次
 * （实测去掉 order 后拿回来的仍是空串）。
 */
function rawCssInTests(): Plugin {
  return {
    name: "larix:raw-css-in-tests",
    transform: {
      order: "post",
      handler(_code, id) {
        if (!id.endsWith(".css?raw")) return null;
        const file = id.slice(0, -"?raw".length).replace(/^\/+([A-Za-z]:)/, "$1");
        return `export default ${JSON.stringify(readFileSync(file, "utf8"))};`;
      },
    },
  };
}

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    react(),
    // @ts-expect-error process is a nodejs global
    ...(process.env.VITEST ? [rawCssInTests()] : []),
  ],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
          dockview: ["dockview", "dockview-react"],
          uplot: ["uplot"],
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
