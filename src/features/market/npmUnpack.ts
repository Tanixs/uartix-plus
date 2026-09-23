/**
 * P99c-R2：把一枚 npm tarball（`.tgz`）里的**那一枚清单**取出来。
 *
 * 边界先说死，因为这三条决定了"我们不执行第三方代码"是事实而不是一句声明：
 *  1. **只读一个成员**：`package/uartix-plugin.json`。npm 的打包规则是给所有路径加 `package/` 前缀
 *     （实测：`package/index.js`、`package/package.json`、`package/postinstall.js`），
 *     我们的目标名固定 26 个字符，因此不触发 pax/GNU 长名扩展——长名头一律按"未知成员"跳过；
 *  2. **不落盘、不解依赖、不跑任何包内脚本**：整个模块只有字节运算，没有 `eval`、没有动态构造函数、
 *     没有子进程，所以 `postinstall` 那类 lifecycle 在这里根本没有执行路径可走
 *     （`marketUi.test` 有一条扫这三样的源文本钉，见 G12）；
 *  3. **两处字节上限都是硬的**：解压过程边读边比（超了立刻 `cancel`），不是"解完再看多大"。
 *     一枚 4 MiB 的 gzip 能解出几个 G，只比压缩后的数等于没比。
 *
 * 为什么在前端做而不动 Rust：取回通道 `market_fetch` 已经管住了"域、https、不跟重定向、字节上限、sha256"
 * （那些才是信任边界），解包只是把字节变成一个 JSON 文本——放 Rust 要么加 `flate2`/`tar` 依赖，
 * 要么把 tar 头再抄一遍（第二真相）。gzip 用平台自带的 `DecompressionStream`，两边（WebView2 / Node）同一份实现。
 */
import { MARKET_PKG_MAX_BYTES } from "./marketIndex";

/** npm 包根：registry 的 tarball 一律带这一层前缀（实测口径，不是猜的） */
export const NPM_MEMBER = "package/uartix-plugin.json";
/**
 * 解出来的 tar 上限。取回时已按 `MARKET_PKG_MAX_BYTES` 卡过压缩字节，这里卡的是**解压之后**——
 * 两个数是两件事（gzip 炸弹），所以必须各有一条。给 2 倍加一个页头余量：正常包里 headers + 正文就是这个量级。
 */
export const NPM_UNPACK_MAX_BYTES = MARKET_PKG_MAX_BYTES * 2 + 64 * 1024;
/** 出错时回给人看的成员名最多几条、每条几个字符（诊断有用，但那是外部可控字符串） */
const NAME_TAIL = 12;
const NAME_MAX = 100;

const BLOCK = 512;

export type UnpackResult = { ok: true; text: string; bytes: number } | { ok: false; msg: string; members: string[] };

/** gzip → 字节。**边读边比上限**，越线立刻中止（不是解完再量）。 */
async function gunzip(bytes: Uint8Array, max: number): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    total += chunk.length;
    if (total > max) {
      // cancel 而不是继续读：让上游连接/流自己收摊，也别把那几 G 留在内存里
      await reader.cancel();
      throw new Error(`解压后 ${total} 字节，超过上限 ${max}——已中止`);
    }
    parts.push(chunk);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** 头部字符串字段：NUL 截断 + trim（有些实现留空格填充） */
function field(tar: Uint8Array, from: number, to: number): string {
  let end = from;
  while (end < to && tar[end] !== 0) end++;
  let s: string;
  try {
    s = new TextDecoder("utf-8", { fatal: false }).decode(tar.subarray(from, end));
  } catch {
    return "";
  }
  return s.trim();
}

/**
 * 八进制 size 字段（`name[124..136]`）。
 * 最高位是 1 的按 GNU 的 base-256 大数解释——那种包根本不是我们的东西，直接判坏（不猜它多大）。
 */
function octalSize(tar: Uint8Array, at: number): number | null {
  const raw = field(tar, at, at + 12);
  if (!raw) return null;
  if (!/^[0-7]+$/.test(raw)) return null;
  const n = Number.parseInt(raw, 8);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** 成员名：ustar 的 `prefix` 字段（345..500）非空时要拼在前面——只认 name 会把带前缀的包全判成"没有清单"。 */
function memberName(tar: Uint8Array, at: number): string {
  const name = field(tar, at, at + 100);
  const prefix = field(tar, at + 345, at + 500);
  return prefix ? `${prefix}/${name}` : name;
}

/** 给人看的成员名清单：条数与长度都封住（那是外部可控字符串，不能整包回显）。 */
function briefNames(names: string[]): string[] {
  return names.slice(0, NAME_TAIL).map((n) => (n.length > NAME_MAX ? `${n.slice(0, NAME_MAX)}…` : n));
}

/**
 * 在**未压缩**的 tar 字节里找那一枚成员。
 * 目录/符号链接/扩展头这些类型一律按 size 跳过（不解释内容），所以不认识的格式只会"找不到"，不会读错。
 */
export function pickTarMember(tar: Uint8Array, want: string, maxOut: number): { bytes?: Uint8Array; names: string[]; error?: string } {
  const names: string[] = [];
  let at = 0;
  while (at + BLOCK <= tar.length) {
    // 结束块：全零（GNU/BSD 都在档案尾放两个零块）
    if (tar[at] === 0) return { names, error: `包里没有 ${want}（见到 ${names.length ? briefNames(names).join("、") : "空档案"}）` };
    const name = memberName(tar, at);
    const size = octalSize(tar, at + 124);
    if (!name || size === null) return { names, error: `tar 头读不动（偏移 ${at}）：不是合法的 ustar 档案` };
    const type = String.fromCharCode(tar[at + 156] || 0x30);
    names.push(name);
    const dataAt = at + BLOCK;
    const nextAt = dataAt + Math.ceil(size / BLOCK) * BLOCK;
    if (nextAt > tar.length) return { names, error: `成员 ${name} 声明 ${size} 字节，档案却在这里就断了` };
    if (name === want) {
      if (type !== "0") return { names, error: `${want} 不是普通文件（tar 类型位是「${type}」）——不解释可疑形状` };
      if (size > maxOut) return { names, error: `${want} 有 ${size} 字节，超过单包上限 ${maxOut}` };
      return { bytes: tar.subarray(dataAt, dataAt + size), names };
    }
    at = nextAt;
  }
  return { names, error: `档案里没有结束块，也没有 ${want}（见到 ${briefNames(names).join("、")}）` };
}

/**
 * `.tgz` → 清单文本。失败回的是**一句人能看懂的原因 + 包里实际有什么**，
 * 因为 R2 最常见的坏法是作者忘了 `package/` 前缀或把清单放在了子目录里（看不见的错误最难自查）。
 */
export async function unpackNpmPackage(tgz: Uint8Array, want: string = NPM_MEMBER): Promise<UnpackResult> {
  let tar: Uint8Array;
  try {
    tar = await gunzip(tgz, NPM_UNPACK_MAX_BYTES);
  } catch (e) {
    return { ok: false, msg: `解压失败：${e instanceof Error ? e.message : String(e)}`, members: [] };
  }
  const hit = pickTarMember(tar, want, MARKET_PKG_MAX_BYTES);
  if (!hit.bytes) return { ok: false, msg: hit.error ?? "解不出来（原因未给出）", members: briefNames(hit.names) };
  const text = new TextDecoder("utf-8", { fatal: true }).decode(hit.bytes);
  return { ok: true, text, bytes: hit.bytes.length };
}
