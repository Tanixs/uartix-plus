/**
 * P99c-R2 守卫：`.tgz` 解包层。
 *
 * 两条腿，缺一不可：
 *  - **真夹具**（`npm pack --ignore-scripts` 出来的 `__fixtures__/probe-1.0.0.tgz`）：证明读的是
 *    npm 真正写出的格式，而不是"我的写器和我的读器彼此误会"（§8-54：第一条测试先断言字节数 > 0）；
 *  - **手搓的坏档案**：只用于**拒绝**路径与"带 prefix 的合法变体"。方向是安全的——认错了就拒，
 *    不会把可疑内容放进来。
 */
import { describe, expect, it } from "vitest";
import { validateManifest } from "../plugins/pluginManifest";
import { MARKET_PKG_MAX_BYTES } from "./marketIndex";
import { NPM_MEMBER, NPM_UNPACK_MAX_BYTES, pickTarMember, unpackNpmPackage } from "./npmUnpack";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as unknown as { readFileSync: (p: string, enc?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
/** 二进制读（同一个 readFileSync，不传 enc 时运行时就是 Buffer） */
const readBin = (rel: string): Uint8Array =>
  (readFileSync as unknown as (p: string) => Uint8Array)(fileURLToPath(new URL(rel, import.meta.url)));

const BLOCK = 512;
const encoder = new TextEncoder();

/** 手搓一员 ustar 头 + 正文（只为造坏档案与"prefix 字段"这一种合法变体） */
function member(name: string, body: Uint8Array, opts: { prefix?: string; type?: string; sizeOverride?: number } = {}): Uint8Array {
  const head = new Uint8Array(BLOCK);
  const put = (s: string, at: number, max: number) => head.set(encoder.encode(s).subarray(0, max), at);
  put(name, 0, 100);
  put((opts.sizeOverride ?? body.length).toString(8).padStart(11, "0"), 124, 11);
  put("0000644", 100, 8);
  head[156] = (opts.type ?? "0").charCodeAt(0);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  if (opts.prefix) put(opts.prefix, 345, 155);
  const pad = Math.ceil(body.length / BLOCK) * BLOCK;
  const out = new Uint8Array(BLOCK + pad);
  out.set(head, 0);
  out.set(body, BLOCK);
  return out;
}

function tarOf(parts: Uint8Array[], withTail = true): Uint8Array {
  const tail = new Uint8Array(withTail ? BLOCK * 2 : 0);
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0) + tail.length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  out.set(tail, at);
  return out;
}

/** 测试侧的 gzip：用平台同一条流的另一头（CompressionStream 与 DecompressionStream 配对，不引第三方） */
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe("P99c-R2 · npmUnpack", () => {
  it("成员名与 npm 的实际打包规则对齐（前缀是 package/，实测来的不是猜的）", () => {
    expect(NPM_MEMBER).toBe("package/uartix-plugin.json");
  });

  it("真夹具不是空的，而且是真 gzip（§8-54：先证数据在，再证判断对不对）", () => {
    const tgz = readBin("__fixtures__/probe-1.0.0.tgz");
    expect(tgz.length, "夹具 0 字节：后面所有绿都是空的").toBeGreaterThan(300);
    expect(tgz[0]).toBe(0x1f);
    expect(tgz[1]).toBe(0x8b);
  });

  it("真包里那一枚清单解得出来，并且过的是同一台生产校验器", async () => {
    const r = await unpackNpmPackage(readBin("__fixtures__/probe-1.0.0.tgz"));
    expect(r.ok, r.ok ? "" : r.msg).toBe(true);
    if (!r.ok) return;
    const parsed = JSON.parse(r.text) as Record<string, unknown>;
    expect(parsed.id).toBe("uartix.probe.theme");
    const v = validateManifest(parsed);
    expect(v.ok, `npm 通路进来的包没过生产校验器：${v.errors.join("；")}`).toBe(true);
    expect(r.bytes).toBe(new TextEncoder().encode(r.text).length);
  });

  it("只取那一枚：包里的 postinstall 与别的成员一概不进回执", async () => {
    const r = await unpackNpmPackage(readBin("__fixtures__/probe-1.0.0.tgz"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 夹具里那些"别的东西"——真被读进来说明解包在捡不该捡的字节（lifecycle 永不执行这条的可达性半边）
    for (const bait of ["postinstall", "decoy", "<div", '"license"']) expect(r.text).not.toContain(bait);
    expect(() => JSON.parse(r.text), "取回来的不是一枚完整 JSON，就是一段多成员拼接").not.toThrow();
    expect(r.bytes).toBe(new TextEncoder().encode(r.text).length);
  });

  it("ustar 的 prefix 字段要参与成员名（只认 name 会把带前缀的包全判成「没有清单」）", () => {
    const body = encoder.encode('{"id":"x"}');
    const hit = pickTarMember(tarOf([member("uartix-plugin.json", body, { prefix: "package" })]), NPM_MEMBER, MARKET_PKG_MAX_BYTES);
    expect(hit.error, hit.error ?? "").toBeUndefined();
    expect(new TextDecoder().decode(hit.bytes)).toBe('{"id":"x"}');
  });

  it("目标成员不是普通文件（符号链接）⇒ 拒，不解释可疑形状", () => {
    const hit = pickTarMember(tarOf([member(NPM_MEMBER, encoder.encode(""), { type: "2" })]), NPM_MEMBER, MARKET_PKG_MAX_BYTES);
    expect(hit.error).toContain("不是普通文件");
    expect(hit.names.length).toBeGreaterThan(0);
  });

  it("成员声明得比单包上限还大 ⇒ 拒（不是截一半继续用）", () => {
    // 上限这里给的是"比成员实际大小还小"的数：真正要验的是"超了就拒"这条分支，
    // 而不是拿 4 MiB 的零缓冲在测试里走一遍（那样只会测到下面那条"档案断了"）。
    const hit = pickTarMember(tarOf([member(NPM_MEMBER, encoder.encode("01234567890123456789"))]), NPM_MEMBER, 10);
    expect(hit.error).toContain("超过单包上限");
  });

  it("声明的 size 越过档案实际长度 ⇒ 判坏，不去读那块不存在的内存", () => {
    const hit = pickTarMember(tarOf([member(NPM_MEMBER, encoder.encode("{}"), { sizeOverride: 65536 })]), NPM_MEMBER, MARKET_PKG_MAX_BYTES);
    expect(hit.error).toContain("档案却在这里就断了");
  });

  it("档案不完整 / 找不到目标：各回一句真话并列出包里实际有什么", () => {
    const head = member(NPM_MEMBER, encoder.encode("{}"));
    const cut = pickTarMember(head.subarray(0, 300), NPM_MEMBER, MARKET_PKG_MAX_BYTES);
    expect(cut.error).toContain("结束块");
    const missing = pickTarMember(tarOf([head]), "nope/there.json", MARKET_PKG_MAX_BYTES);
    expect(missing.error).toContain("没有");
    // 作者最常见的错法是忘了 `package/` 前缀——不列出包里实际有什么，他看不出来差在哪
    expect(missing.error).toContain(NPM_MEMBER);
    const noTail = pickTarMember(tarOf([head], false), "nope/there.json", MARKET_PKG_MAX_BYTES);
    expect(noTail.error).toBeTruthy();
  });

  it("gzip 炸弹：解压到上限就中止，不是解完再量", async () => {
    const tgz = await gzip(new Uint8Array(NPM_UNPACK_MAX_BYTES + 1024));
    expect(tgz.length, "夹具自己没压小，这条就没测到炸弹").toBeLessThan(10_000);
    const r = await unpackNpmPackage(tgz);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.msg).toContain("超过上限");
  });

  it("根本不是 gzip 的字节 ⇒ 一句「解压失败」，不抛出去", async () => {
    const r = await unpackNpmPackage(encoder.encode("这根本不是一枚 tar.gz"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.msg).toContain("解压失败");
  });
});
