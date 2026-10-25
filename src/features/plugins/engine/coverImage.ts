/**
 * P174-R3：从旧插件库迁来的封面/截图压缩器。
 *
 * 旧 UI 已经不再使用旧 `pluginManifest` 的常量；这里自带同一套预算（200KB / 1024px），
 * 让新引擎的展示信息不再依赖旧包格式。
 */
export const COVER_MAX_BYTES = 200 * 1024;
export const COVER_MAX_EDGE = 1024;

/** data URL 的 base64 段解码后字节数（预算判据）。 */
export function coverBytes(dataUrl: string): number {
  const i = dataUrl.indexOf(",");
  if (i < 0) return 0;
  const b64 = dataUrl.slice(i + 1);
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

/** 等比缩到最长边 ≤ max；非法尺寸回落 1×1（调用方本应先拒非法文件）。 */
export function fitSize(w: number, h: number, max = COVER_MAX_EDGE): { w: number; h: number } {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { w: 1, h: 1 };
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

export const approxDataUrlBytes = coverBytes;

const RAW_OK = new Set(["image/png", "image/jpeg", "image/webp"]);

function readAsDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error("读取失败"));
    r.readAsDataURL(f);
  });
}

async function compress(file: File, label: string): Promise<string> {
  const bmp = await createImageBitmap(file);
  try {
    let { w, h } = fitSize(bmp.width, bmp.height);
    for (let round = 0; round < 3; round++) {
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("画布不可用");
      ctx.drawImage(bmp, 0, 0, w, h);
      for (const q of [0.85, 0.75, 0.65, 0.55]) {
        const url = canvas.toDataURL("image/jpeg", q);
        if (approxDataUrlBytes(url) <= COVER_MAX_BYTES) return url;
      }
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
    }
    throw new Error(`${label}压缩后仍超过 ${Math.round(COVER_MAX_BYTES / 1024)}KB，请换一张更简单的图`);
  } finally {
    bmp.close();
  }
}

export type CoverResult = { ok: true; dataUrl: string } | { ok: false; msg: string };

/** 读一张本地图片为 data URL：≤200KB 的 png/jpeg/webp 原样保留，其余压成 JPEG。 */
export async function readPicture(file: File, label = "封面"): Promise<CoverResult> {
  if (!file.type.startsWith("image/")) return { ok: false, msg: `${label}不是图片文件` };
  if (file.size > 12 * 1024 * 1024) return { ok: false, msg: `${label}超过 12MB，请先裁小` };
  try {
    if (RAW_OK.has(file.type) && file.size <= COVER_MAX_BYTES) {
      return { ok: true, dataUrl: await readAsDataUrl(file) };
    }
    return { ok: true, dataUrl: await compress(file, label) };
  } catch (e) {
    return { ok: false, msg: `${label}处理失败：${String(e).replace(/^Error:\s*/, "").slice(0, 120)}` };
  }
}

export function readCover(file: File): Promise<CoverResult> {
  return readPicture(file, "封面");
}
