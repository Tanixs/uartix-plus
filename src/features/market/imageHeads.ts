/**
 * P99b-N3：图片头部的**纯**判读（格式白名单、尺寸上限、只解头部的宽高读取）。
 *
 * 单独一个文件只为一件事：**不许为了读一张图的宽高而把 store 拖进来**——
 * `marketImages.ts` 要取图就得 import `marketStore`（localStorage/IPC 副作用），
 * 而货架内容测试只想问"这张 PNG 是几乘几"。派生与副作用分开，两边才都测得动（§8-48 同族）。
 */

/** 只放位图。`image/jpg` 是有些服务器会说的别名，拒它等于把真好图判坏；SVG 明确拒（见下）。 */
export const IMAGE_MIME_ALLOW: readonly string[] = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"];
/** 单边与总像素上限：正常 4K 截图（3840×2160）离它还很远，挡的是"一张 2 万像素长图拖死首屏" */
export const IMAGE_MAX_EDGE = 8192;
export const IMAGE_MAX_PIXELS = 25_000_000;

/**
 * 格式那道门看的是**服务端说的 mime**，不是状态码也不是文件后缀：
 * `200 + text/html` 正是代理错误页的形状（参照物那条"拒收伪装成 200 的页面"）；
 * SVG 是脚本容器，就算 `<img>` 里不执行，放行它也等于给"货架上的图"开一条格式后门。
 */
export function mimeAllowed(mime: string): boolean {
  return IMAGE_MIME_ALLOW.includes(mime.trim().toLowerCase());
}

const asciiAt = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.slice(i, i + n));
const be16 = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const le16 = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8);
const be32 = (b: Uint8Array, i: number) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

/** data URL 里只取前 n 个字节（量尺寸不需要整张解码；base64 按 4 字符=3 字节对齐切） */
function headBytes(dataUrl: string, n: number): Uint8Array | null {
  const comma = dataUrl.indexOf(",");
  if (comma < 0 || !dataUrl.slice(0, comma).includes("base64")) return null;
  const b64 = dataUrl.slice(comma + 1);
  const chars = Math.min(b64.length - (b64.length % 4), Math.ceil(n / 3) * 4);
  if (chars < 4) return null;
  try {
    const bin = atob(b64.slice(0, chars));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * 从图片头部读宽高；读不出来返回 **null**（调用方要照实放行——
 * "unknown ≠ 不兼容"，与参照物"只隐藏确认不匹配的"是同一条诚实原则）。
 */
export function readImageDims(dataUrl: string): { w: number; h: number } | null {
  const b = headBytes(dataUrl, 65536);
  if (!b || b.length < 16) return null;
  // PNG：签名后第 16/20 字节是 IHDR 的宽高（大端）
  if (b[0] === 0x89 && asciiAt(b, 1, 3) === "PNG") return { w: be32(b, 16), h: be32(b, 20) };
  if (asciiAt(b, 0, 3) === "GIF") return { w: le16(b, 6), h: le16(b, 8) };
  if (asciiAt(b, 0, 4) === "RIFF" && asciiAt(b, 8, 4) === "WEBP") {
    const tag = asciiAt(b, 12, 4);
    // 扩展头：24 位小端，存的是"尺寸 - 1"
    if (tag === "VP8X") {
      return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
    // 无损：偏移 20 是 0x2f 签名，随后 4 字节位打包的 14 位宽高
    if (tag === "VP8L") {
      const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
      return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >>> 14) & 0x3fff) };
    }
    // 有损：帧头里 14 位宽高
    if (tag === "VP8 ") return { w: le16(b, 26) & 0x3fff, h: le16(b, 28) & 0x3fff };
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    // JPEG：一段一段跳，找 SOF（0xC4/0xC8/0xCC 不是帧头）
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { h: be16(b, i + 5), w: be16(b, i + 7) };
      }
      const len = be16(b, i + 2);
      if (len < 2) return null;
      i += 2 + len;
    }
    return null;
  }
  return null;
}

/** 超限判定（尺寸已知才判；未知一律放行）。返回给用户看的那句话，没超限返回空串。 */
export function oversizeText(dims: { w: number; h: number } | null): string {
  if (!dims || dims.w <= 0 || dims.h <= 0) return "";
  const edge = Math.max(dims.w, dims.h);
  const pixels = dims.w * dims.h;
  if (edge <= IMAGE_MAX_EDGE && pixels <= IMAGE_MAX_PIXELS) return "";
  return `这张图 ${dims.w}×${dims.h}，超过显示上限（单边 ${IMAGE_MAX_EDGE} 或总像素 ${Math.round(IMAGE_MAX_PIXELS / 1e6)} 百万），不显示——不是图坏了，是它太大`;
}
