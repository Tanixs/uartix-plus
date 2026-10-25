/**
 * P174-R17：市场卡片的封面砖。
 *
 * 封面是**包根约定**，不是清单字段：发布器会把用户选的封面写成 `cover.<ext>` 放在仓库根，
 * 而搜索接口只给仓库元数据、拿不到包内清单。
 *
 * 为什么走 `api.github.com/contents` 而不是 raw 图床：
 * raw 在很多网络里解析不了（本机实测：api 通、raw 直接 DNS 失败），封面会集体消失；
 * 而搜索本来就走 API 那条通道，同一条路的可达性已经被证明过。代价是吃核心额度，
 * 所以带上设置里的 token（5000 次/小时），并为失败加熔断——见 `marketClient.repoCover`。
 */
/**
 * 封面候选的**优先顺序**：JPEG 在前。
 *
 * 发布器按用户选中的图片类型落盘；大图/截图会被封面压缩器转成 JPEG，所以 `cover.jpg`
 * 通常是"最新那次发布"的产物。而旧的 `cover.png` 在换类型时不会被删——真机事故：
 * YOLO 仓库同时躺着两张，旧 `cover.png` 盖住了新 `cover.jpg`，市场里显示的是上一版封面。
 */
export const COVER_FILES = ["cover.jpg", "cover.png", "cover.webp"] as const;

/** 封面预算：发布器压到 200KB，这里按 base64 + JSON 信封留一倍余量。 */
export const COVER_MAX_FETCH_BYTES = 384 * 1024;

/**
 * 候选地址：按 `COVER_FILES` 顺序拼。
 *
 * owner/name 来自 GitHub 搜索响应，理论上已合法；仍然编码——仓库名允许 `.`，
 * 把用户可控字符串原样拼进路径从来不是好习惯。分支进的是 `ref` 查询参数，
 * 整个编码（`feat/cover` → `feat%2Fcover`）而不是当路径段。
 */
export function coverCandidates(repo: { owner: string; name: string; defaultBranch: string }): string[] {
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.name);
  const branch = String(repo.defaultBranch || "main")
    .split("/")
    .map((s) => s.replace(/[^\w.-]/g, ""))
    .filter((s) => s && s !== "." && s !== "..")
    .join("/");
  if (!owner || !name || !branch) return [];
  return COVER_FILES.map(
    (f) => `https://api.github.com/repos/${owner}/${name}/contents/${f}?ref=${encodeURIComponent(branch)}`,
  );
}

/**
 * 读 contents API 的文件信封：`{ encoding: "base64", content: "…" }` → 原始字节。
 *
 * 目录列表/README 不走这里；封面与详情预览图共用它。
 * 不是 JSON / 编码不是 base64（GitHub 对 >1MB 的文件会省略 content）/ 超过预算，
 * 一律当"没有这张图"——失败的正确后果是换文字砖或跳过，而不是弹错误。
 */
export function gitHubFileBytes(json: string, maxBytes = COVER_MAX_FETCH_BYTES): Uint8Array | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { content?: unknown; encoding?: unknown; size?: unknown };
  if (o.encoding !== "base64" || typeof o.content !== "string") return null;
  if (typeof o.size === "number" && (o.size <= 0 || o.size > maxBytes)) return null;
  let bin: string;
  try {
    bin = atob(o.content.replace(/\s+/g, ""));
  } catch {
    return null;
  }
  if (!bin.length || bin.length > maxBytes) return null;
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 读图片头，只认能安全直接 `img` 的三种（与本地封面预算同一口径）。 */
export function imageMime(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** 没有封面时的字符砖：多词取首字母（fluent-dark → FD），单词取第一个字母。 */
export function coverInitials(name: string): string {
  const words = Array.from(String(name || "").matchAll(/[\p{L}\p{N}]+/gu)).map((m) => m[0]);
  if (!words.length) return "?";
  if (words.length === 1) {
    const chars = Array.from(words[0]);
    return chars.slice(0, 1).join("").toUpperCase();
  }
  return (Array.from(words[0])[0] + Array.from(words[1])[0]).toUpperCase();
}

/** 文字砖的渐变：卡片与详情共用，同一仓库不会在两处显示成两种颜色。 */
export function coverGradient(hue: number): string {
  return `linear-gradient(145deg, hsl(${hue} 52% 44%), hsl(${(hue + 38) % 360} 58% 25%))`;
}

/** 同一仓库永远同一个色相：刷新列表不该让「那枚紫色的插件」突然变绿。 */
export function coverHue(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 360;
}
