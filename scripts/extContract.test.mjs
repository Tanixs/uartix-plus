/**
 * P174-A4：跨语言契约——账本名在 Rust 与 TS 两端必须一致。
 *
 * 为什么需要这条：`ext_store_write` 的 `name` 在 Rust 侧是白名单，TS 侧是常量。
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

/** 从 TS 源码抽 `export const EXT_STORE_NAMES = ["a", "b"] as const;`。 */
export function parseTsStoreNames(src) {
  const m = src.match(/export\s+const\s+EXT_STORE_NAMES\s*=\s*\[([^\]]*)\]/);
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
}

describe("P174-A4 · 账本名跨语言契约", () => {
  it("两端抽得出名字（抽不到就是判据自己失效，必须红）", () => {
    const rust = readFileSync(path.join(ROOT, "src-tauri/src/ext_fs.rs"), "utf8");
    const ts = readFileSync(path.join(ROOT, "src/features/extensions/store.ts"), "utf8");
    expect(parseRustStoreNames(rust)).not.toBeNull();
    expect(parseTsStoreNames(ts)).not.toBeNull();
  });

  it("Rust 白名单与 TS 常量逐项相同", () => {
    const rust = readFileSync(path.join(ROOT, "src-tauri/src/ext_fs.rs"), "utf8");
    const ts = readFileSync(path.join(ROOT, "src/features/extensions/store.ts"), "utf8");
    expect(parseRustStoreNames(rust)).toEqual(parseTsStoreNames(ts));
  });

  it("解析器本身能分辨差异（反向夹具：门不是永远的绿）", () => {
    const a = 'const STORE_NAMES: [&str; 1] = ["index"];';
    const b = 'export const EXT_STORE_NAMES = ["index", "trust"] as const;';
    expect(parseRustStoreNames(a)).not.toEqual(parseTsStoreNames(b));
  });
});
