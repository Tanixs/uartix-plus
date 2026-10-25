/**
 * P174-A13：解包器的判据。
 *
 * 这组用例的价值不在"能不能解出一个文件"（那部分错了会立刻炸），而在**坏包的处理**：
 * 一个包里放 `../../x`、放符号链接、放 3 万个文件，插件目录会被写成什么样。
 * 那些情形不会报错，只会让磁盘上出现一些"不该在那里的文件"。
 */
import { describe, expect, it } from "vitest";
import {
  UNPACK_LIMITS,
  parseTar,
  safeMemberPath,
  stripCommonTopDir,
  unpackTarGz,
} from "./packUnpack";

/** 用 CompressionStream 造 gzip（与生产解压同一条 Web API，不引 node 类型）。 */
async function gz(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 更直白的版本：checksum 用空格占位算（读方不校验，这里只要头结构合法）。 */
function header(name: string, size: number, type = "0"): Uint8Array {
  const h = new Uint8Array(512);
  const enc = new TextEncoder();
  h.set(enc.encode(name).subarray(0, 99), 0);
  h.set(enc.encode(size.toString(8).padStart(11, "0") + " "), 124);
  h.set(enc.encode("0000000 "), 136);
  h[156] = type.charCodeAt(0);
  h.set(enc.encode("ustar\u000000"), 257);
  // checksum 区（148..156）留空格即可：解析器不验它（验的话要用两遍算法，测试里没必要）
  h.fill(0x20, 148, 156);
  return h;
}

function pad(n: number): number {
  return (512 - (n % 512)) % 512;
}

function entry(name: string, text: string | Uint8Array, type = "0"): Uint8Array[] {
  const body = typeof text === "string" ? new TextEncoder().encode(text) : text;
  const out = [header(name, body.length, type), body];
  if (body.length % 512) out.push(new Uint8Array(pad(body.length)));
  return out;
}

function tarOf(parts: Uint8Array[][]): Uint8Array {
  const pieces: Uint8Array[] = [];
  for (const p of parts) pieces.push(...p);
  pieces.push(new Uint8Array(1024)); // 结尾两块
  const total = pieces.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of pieces) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe("safeMemberPath", () => {
  it("普通路径放行；`..`、绝对路径、盘符、空段一律拒", () => {
    expect(safeMemberPath("plugin.json")).toBe("plugin.json");
    expect(safeMemberPath("./a/b.txt")).toBe("a/b.txt");
    expect(safeMemberPath("a\\b.txt")).toBe("a/b.txt");
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/x", "a//b", "  ", ""]) {
      expect(safeMemberPath(bad), `${bad} 应当被拒`).toBeNull();
    }
  });
});

describe("parseTar", () => {
  it("解出普通文件；目录不产生条目", () => {
    const tar = tarOf([entry("pkg/", "", "5"), entry("pkg/plugin.json", '{"a":1}'), entry("pkg/main.mjs", "export {}")]);
    const r = parseTar(tar);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files.map((f) => f.name)).toEqual(["pkg/plugin.json", "pkg/main.mjs"]);
    expect(new TextDecoder().decode(r.files[0].bytes)).toBe('{"a":1}');
  });

  it("符号链接被跳过，而且**列出来**（跳过的东西必须能被看见）", () => {
    const tar = tarOf([entry("pkg/a", "../etc/passwd", "2"), entry("pkg/plugin.json", "{}")]);
    const r = parseTar(tar);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files.map((f) => f.name)).toEqual(["pkg/plugin.json"]);
    expect(r.skipped.join()).toContain("pkg/a");
  });

  it("路径逃逸的条目不会出现在结果里（包再怎么写也跳不出解包目录）", () => {
    const tar = tarOf([entry("../../evil.sh", "rm -rf /"), entry("ok.txt", "hi")]);
    const r = parseTar(tar);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.files.map((f) => f.name)).toEqual(["ok.txt"]);
    expect(r.skipped.join()).toContain("evil.sh");
  });

  it("条数超限 ⇒ 整包拒（不是截断：装一半的包比装不上更难查）", () => {
    const many = Array.from({ length: 6 }, (_, i) => entry(`f${i}.txt`, "x"));
    const r = parseTar(tarOf(many), { ...UNPACK_LIMITS, maxFiles: 5 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.msg).toContain("文件数超过上限");
  });

  it("空包 ⇒ 拒，并说清楚", () => {
    const r = parseTar(new Uint8Array(1024));
    expect(r.ok).toBe(false);
  });
});

describe("stripCommonTopDir", () => {
  it("同一个顶层目录 ⇒ 剥掉（GitHub 归档就是这种）", () => {
    const files = [
      { name: "o-r-abc/plugin.json", bytes: new Uint8Array() },
      { name: "o-r-abc/main.mjs", bytes: new Uint8Array() },
    ];
    expect(stripCommonTopDir(files).map((f) => f.name)).toEqual(["plugin.json", "main.mjs"]);
  });

  it("顶层混着文件与目录 ⇒ 原样返回（强行剥会让两个文件撞名）", () => {
    const files = [
      { name: "plugin.json", bytes: new Uint8Array() },
      { name: "sub/a.txt", bytes: new Uint8Array() },
    ];
    expect(stripCommonTopDir(files).map((f) => f.name)).toEqual(["plugin.json", "sub/a.txt"]);
  });
});

describe("unpackTarGz（整条）", () => {
  it("gunzip → 解包 → 剥顶层目录，二进制原样回来", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x80]);
    const tar = tarOf([entry("repo-abc/plugin.json", "{}"), entry("repo-abc/logo.png", png)]);
    const r = await unpackTarGz(await gz(tar));
    expect(r.ok, r.ok ? "" : r.msg).toBe(true);
    if (!r.ok) return;
    expect(r.files.map((f) => f.name)).toEqual(["plugin.json", "logo.png"]);
    expect([...r.files[1].bytes]).toEqual([...png]);
  });

  it("不是 gzip ⇒ 一句人话（不是崩在 DecompressionStream 里）", async () => {
    const r = await unpackTarGz(new Uint8Array([1, 2, 3, 4]));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.msg).toContain("不是一个 gzip 包");
  });
});
