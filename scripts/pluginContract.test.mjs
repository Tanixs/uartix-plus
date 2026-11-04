/**
 * P174-A4：跨语言契约——账本名在 Rust 与 TS 两端必须一致。
 *
 * 为什么需要这条：`plugin_store_write` 的 `name` 在 Rust 侧是白名单，TS 侧是常量。
 * 两边不一致的症状是**"写得进读不出"或"读得出写不进"，而两端各自都不报错**——
 * 一个存成 `index`、另一个读 `index.json` 之类的错位，最后表现为"插件装完下次启动就没了"。
 *
 * 判据直接读两份源码做集合比对，不靠人记、也不靠"在两边各写一份注释说要对齐"。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 从 Rust 源码抽 `const STORE_NAMES: [&str; N] = ["a", "b"];`。抽不到返回 null（判红，不静默）。 */
export function parseRustStoreNames(src) {
  const m = src.match(/const\s+STORE_NAMES\s*:\s*\[&str;\s*\d+\]\s*=\s*\[([^\]]*)\]/);
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
}

/** 从 TS 源码抽 `export const PLUGIN_STORE_NAMES = ["a", "b"] as const;`。 */
export function parseTsStoreNames(src) {
  const m = src.match(/export\s+const\s+PLUGIN_STORE_NAMES\s*=\s*\[([^\]]*)\]/);
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
}

describe("P174-A4 · 账本名跨语言契约", () => {
  it("两端抽得出名字（抽不到就是判据自己失效，必须红）", () => {
    const rust = readFileSync(path.join(ROOT, "src-tauri/src/plugin_fs.rs"), "utf8");
    const ts = readFileSync(path.join(ROOT, "src/features/plugins/engine/store.ts"), "utf8");
    expect(parseRustStoreNames(rust)).not.toBeNull();
    expect(parseTsStoreNames(ts)).not.toBeNull();
  });

  it("Rust 白名单与 TS 常量逐项相同", () => {
    const rust = readFileSync(path.join(ROOT, "src-tauri/src/plugin_fs.rs"), "utf8");
    const ts = readFileSync(path.join(ROOT, "src/features/plugins/engine/store.ts"), "utf8");
    expect(parseRustStoreNames(rust)).toEqual(parseTsStoreNames(ts));
  });

  it("解析器本身能分辨差异（反向夹具：门不是永远的绿）", () => {
    const a = 'const STORE_NAMES: [&str; 1] = ["index"];';
    const b = 'export const PLUGIN_STORE_NAMES = ["index", "trust"] as const;';
    expect(parseRustStoreNames(a)).not.toEqual(parseTsStoreNames(b));
  });
});

/* ============================================================================
   2026-11-03 · 体积上限跨语言契约
   ----------------------------------------------------------------------------
   这些数字现在有 TS（`limits.ts`）与 Rust（`plugin_limits.rs`）两份投影。
   两份漂开的症状是最难查的一类：前端放行了、Rust 在落盘/出网那一步再拒，
   用户看到 `content_too_large`，而"到底哪个上限在生效"没人说得清。
   所以这里直接读两份源码比对，不靠注释说"记得同步"。
   ============================================================================ */

/** 从 `export const NAME = 16 * 1024 * 1024;` 抽字节数。抽不到返回 null（判红）。 */
export function parseTsMiB(src, name) {
  const m = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(\\d+)\\s*\\*\\s*1024\\s*\\*\\s*1024`).exec(src);
  return m ? Number(m[1]) * 1024 * 1024 : null;
}

/** 从 `pub const NAME: usize = 16 * 1024 * 1024;` 抽字节数。 */
export function parseRustMiB(src, name) {
  const m = new RegExp(`pub\\s+const\\s+${name}\\s*:\\s*usize\\s*=\\s*(\\d+)\\s*\\*\\s*1024\\s*\\*\\s*1024`).exec(src);
  return m ? Number(m[1]) * 1024 * 1024 : null;
}

describe("2026-11-03 · 体积上限跨语言契约", () => {
  const ts = readFileSync(path.join(ROOT, "src/features/plugins/engine/limits.ts"), "utf8");
  const rust = readFileSync(path.join(ROOT, "src-tauri/src/plugin_limits.rs"), "utf8");

  const pairs = [
    ["单文件", "PLUGIN_MAX_FILE_BYTES", "PLUGIN_MAX_FILE_BYTES"],
    ["整包", "PLUGIN_MAX_PACKAGE_BYTES", "PLUGIN_MAX_PACKAGE_BYTES"],
    ["单次传输", "PLUGIN_MAX_TRANSFER_BYTES", "PLUGIN_MAX_TRANSFER_B64_BYTES"],
  ];

  it("两端抽得出数字（抽不到就是判据自己失效）", () => {
    for (const [, tsName, rustName] of pairs) {
      expect(parseTsMiB(ts, tsName), `TS 侧抽不到 ${tsName}`).not.toBeNull();
      expect(parseRustMiB(rust, rustName), `Rust 侧抽不到 ${rustName}`).not.toBeNull();
    }
  });

  it("同一组上限在两份源码里逐项相同", () => {
    for (const [label, tsName, rustName] of pairs) {
      expect(parseTsMiB(ts, tsName), `${label}上限漂了（TS ${tsName} / Rust ${rustName}）`).toBe(
        parseRustMiB(rust, rustName),
      );
    }
  });

  it("发布单文件的 base64 上限至少容得下 16 MiB 原文件（4/3 膨胀）", () => {
    const raw = parseRustMiB(rust, "PLUGIN_MAX_FILE_BYTES");
    const b64 = parseRustMiB(rust, "PLUGIN_MAX_PUBLISH_FILE_B64_BYTES");
    // 16 MiB 原文件编码后约 22.37 MB；写 16 MiB 就会把 12 MiB 以上的文件拦在门外
    expect(b64).toBeGreaterThanOrEqual(Math.ceil((raw * 4) / 3));
  });

  it("反向夹具：两份源码不同就必须判红", () => {
    expect(parseTsMiB("export const X = 16 * 1024 * 1024;", "X")).toBe(16 * 1024 * 1024);
    expect(parseRustMiB("pub const X: usize = 8 * 1024 * 1024;", "X")).toBe(8 * 1024 * 1024);
  });
});
