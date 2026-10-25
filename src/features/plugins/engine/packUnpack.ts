/**
 * P174-A13：把一枚 `.tar.gz` 解成"文件列表"（纯函数，可单测）。
 *
 * 为什么用 tar.gz 而不是 zip：GitHub 的仓库归档有 `codeload.github.com/<o>/<r>/tar.gz/<ref>`
 * 这条**直给 200** 的地址（zip 那条要先过一次 302，而市场的取回通道**刻意不跟重定向**，
 * 跟过去就等于白名单可以用一次跳转绕出去）。而 gzip 这一层 `DecompressionStream("gzip")`
 * 在 WebView2 与 Node 18+ 都有，于是不需要给 Rust 加 `flate2` / `zip` 两个依赖。
 *
 * 三道闸都在这里，不留给调用方：
 * 1. **路径**：绝对路径、`..`、盘符、反斜杠一律拒（解包写出到磁盘的东西，路径就是安全边界）；
 * 2. **体量**：条数 / 单文件 / 总量都有上限（与 `PLUGIN_LIMITS` 同一量级），超了就整包拒——
 *    截断一个包装进去，得到的是"装上了但少文件"，那种故障没人能归因；
 * 3. **只收普通文件**：符号链接、硬链接、设备文件一律跳过并**列出来**
 *    （跳过的东西必须能被看见，否则包里放了什么就没人知道了）。
 */

export interface PackFile {
  /** 包内相对路径，已归一成 `/` 分隔。 */
  name: string;
  bytes: Uint8Array;
}

export interface UnpackOk {
  ok: true;
  files: PackFile[];
  /** 被跳过的条目（非普通文件 / 不可解析的头），要能显示给用户。 */
  skipped: string[];
}
export interface UnpackErr {
  ok: false;
  msg: string;
}

export interface UnpackLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

/** 与 `PLUGIN_LIMITS` 同量级：包不该比"一个插件包"更大。 */
export const UNPACK_LIMITS: UnpackLimits = {
  maxFiles: 2000,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 64 * 1024 * 1024,
};

/** 路径归一 + 判死。返回 null ＝ 这条不该被写出去。 */
export function safeMemberPath(raw: string): string | null {
  const s = String(raw ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .trim();
  if (!s) return null;
  if (s.startsWith("/")) return null; // 绝对路径
  if (/^[a-zA-Z]:/.test(s)) return null; // 盘符（Windows 归档里真的出现过）
  const parts = s.split("/");
  if (parts.some((p) => p === "..")) return null; // 往上跳
  if (parts.some((p) => p === "")) return null; // `a//b` 这种先归一，别让它变成两段
  if (s.length > 512) return null;
  return s;
}

function readStr(buf: Uint8Array, off: number, len: number): string {
  let end = off;
  const stop = Math.min(off + len, buf.length);
  while (end < stop && buf[end] !== 0) end++;
  return new TextDecoder().decode(buf.subarray(off, end));
}

function readOctal(buf: Uint8Array, off: number, len: number): number {
  const s = readStr(buf, off, len).trim();
  if (!s) return 0;
  const n = parseInt(s.replace(/[^0-7]/g, ""), 8);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 解析 tar（ustar / GNU / pax 三种头都见得到：GitHub 打的是 pax）。
 *
 * 只认普通文件（`0` / `\0` / `7`）与目录（`5`，跳过）；`L`（GNU 长名）与 `x`（pax 扩展头）
 * 用来补全下一条的路径，不单独产出文件。
 */
export function parseTar(tar: Uint8Array, limits: UnpackLimits = UNPACK_LIMITS): UnpackOk | UnpackErr {
  const files: PackFile[] = [];
  const skipped: string[] = [];
  let off = 0;
  let total = 0;
  let pendingName = ""; // GNU 'L' / pax 'path=' 给下一条用
  let pendingSize = 0;

  while (off + 512 <= tar.length) {
    // 结尾是两片全 0 的块：读到一个就停（不够两片也停，别把填充当文件）
    const header = tar.subarray(off, off + 512);
    let allZero = true;
    for (let i = 0; i < 512; i++) {
      if (header[i] !== 0) {
        allZero = false;
        break;
      }
    }
    if (allZero) break;

    let name = readStr(header, 0, 100);
    const prefix = readStr(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = readOctal(header, 124, 12) || pendingSize;
    const type = String.fromCharCode(header[156] || 48);
    const bodyOff = off + 512;
    const bodyEnd = bodyOff + size;
    if (bodyEnd > tar.length) {
      return { ok: false, msg: `tar 截断：${name || "(无名)"} 声称 ${size} 字节，实际不够` };
    }
    const body = tar.subarray(bodyOff, bodyEnd);
    // 头 + 体都按 512 对齐
    off = bodyOff + Math.ceil(size / 512) * 512;

    if (type === "L") {
      // GNU 长名：体里是下一条的真名（以 NUL 结尾）
      pendingName = readStr(body, 0, body.length);
      continue;
    }
    if (type === "x" || type === "g") {
      // pax 扩展头：可能带 `path=` / `size=`
      const text = new TextDecoder().decode(body);
      const mp = /(?:^|\n)\d+ path=([^\n]+)/.exec(text);
      const ms = /(?:^|\n)\d+ size=(\d+)/.exec(text);
      if (mp) pendingName = mp[1];
      if (ms) pendingSize = Number(ms[1]);
      continue;
    }
    if (type === "5" || type === "1" || type === "2" || type === "3" || type === "4" || type === "6") {
      // 目录不建（写文件时会自动建父目录）；链接/设备一律跳过并留名
      if (type !== "5") skipped.push(`${name}（链接或设备文件，未写入）`);
      pendingName = "";
      pendingSize = 0;
      continue;
    }
    if (type !== "0" && type !== "\u0000" && type !== "7") {
      skipped.push(`${name || "(无名)"}（未知类型 ${JSON.stringify(type)}）`);
      pendingName = "";
      pendingSize = 0;
      continue;
    }

    const realName = pendingName || name;
    pendingName = "";
    pendingSize = 0;
    const safe = safeMemberPath(realName);
    if (!safe) {
      skipped.push(`${String(realName).slice(0, 80)}（路径不安全）`);
      continue;
    }
    if (body.length > limits.maxFileBytes) {
      return { ok: false, msg: `${safe} 超过单文件上限（${body.length} > ${limits.maxFileBytes}）` };
    }
    total += body.length;
    if (total > limits.maxTotalBytes) {
      return { ok: false, msg: `解包后总量超过上限（${total} > ${limits.maxTotalBytes}）` };
    }
    if (files.length >= limits.maxFiles) {
      return { ok: false, msg: `文件数超过上限（${limits.maxFiles}）` };
    }
    // 同名后者覆盖前者：tar 里本来就是这个语义（也防 `L` 头把同一条写两遍）
    const dup = files.findIndex((f) => f.name === safe);
    if (dup >= 0) files.splice(dup, 1);
    files.push({ name: safe, bytes: body.slice() });
  }

  if (!files.length) return { ok: false, msg: "包里没有可用的普通文件（可能是空归档或格式不对）" };
  return { ok: true, files, skipped };
}

/** gunzip。用平台的 `DecompressionStream`，不引 JS 解压库。 */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([new Uint8Array(bytes)]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * GitHub 归档在最外层套了一个 `<owner>-<repo>-<sha>` 目录。
 *
 * 只有当**所有**成员都在同一个顶层目录下时才剥（真包本来也可能就是一个目录）；
 * 混着来的话原样返回——强行剥会把 `a/x` 变成 `x`，两个文件撞名的后果是静默覆盖。
 */
export function stripCommonTopDir(files: PackFile[]): PackFile[] {
  if (!files.length) return files;
  const tops = new Set(files.map((f) => f.name.split("/")[0]));
  if (tops.size !== 1) return files;
  const top = [...tops][0];
  if (!files.every((f) => f.name.includes("/"))) return files;
  return files.map((f) => ({ name: f.name.slice(top.length + 1), bytes: f.bytes }));
}

/** 整条：gunzip → parse → 剥顶层目录。 */
export async function unpackTarGz(
  bytes: Uint8Array,
  limits: UnpackLimits = UNPACK_LIMITS,
): Promise<{ ok: true; files: PackFile[]; skipped: string[] } | UnpackErr> {
  let tar: Uint8Array;
  try {
    tar = await gunzip(bytes);
  } catch (e) {
    return { ok: false, msg: `这不是一个 gzip 包：${String((e as Error)?.message ?? e)}` };
  }
  const parsed = parseTar(tar, limits);
  if (!parsed.ok) return parsed;
  return { ok: true, files: stripCommonTopDir(parsed.files), skipped: parsed.skipped };
}
