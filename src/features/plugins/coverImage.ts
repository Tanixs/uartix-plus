/**
 * P157-E2 · 插件封面：选图 → 缩边 → 压到预算内 → data URL。
 *
 * 为什么统一转 JPEG：插件封面基本都是界面截图/色卡；JPEG 在 200KB 预算里能给到
 * 1024px 长边。原图本来就在预算内且是 png/webp 的，原样保留（transparent logo 不被转坏）。
 *
 * 纯逻辑（`fitSize` / `approxDataUrlBytes`）进单测；canvas 那一段靠活体截图验收
 * （node 测试环境没有 canvas，硬造一个 mock 只能证明 mock 自己）。
 */
import { COVER_MAX_BYTES, COVER_MAX_EDGE, coverBytes } from "./pluginManifest";

/** 等比缩到最长边 ≤ max；非法尺寸回落 1×1（调用方本应先拒非法文件）。 */
export function fitSize(w: number, h: number, max = COVER_MAX_EDGE): { w: number; h: number } {
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return { w: 1, h: 1 };
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** data URL 解码后的字节数（与校验器同一判据，避免"上传过了、导入被拒"的两套账）。 */
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

/** 压到预算内：从 0.85 逐档降质；仍超预算就缩一半再试（最多两轮）。 */
async function compress(file: File): Promise<string> {
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
    throw new Error(`压缩后仍超过 ${Math.round(COVER_MAX_BYTES / 1024)}KB，请换一张更简单的图`);
  } finally {
    bmp.close();
  }
}

export type CoverResult = { ok: true; dataUrl: string } | { ok: false; msg: string };

/** 读一张本地图片为封面 data URL：≤200KB 的 png/jpeg/webp 原样保留，其余压成 JPEG。 */
export async function readCover(file: File): Promise<CoverResult> {
  if (!file.type.startsWith("image/")) return { ok: false, msg: "不是图片文件" };
  if (file.size > 12 * 1024 * 1024) return { ok: false, msg: "图片超过 12MB，请先裁小" };
  try {
    if (RAW_OK.has(file.type) && file.size <= COVER_MAX_BYTES) {
      return { ok: true, dataUrl: await readAsDataUrl(file) };
    }
    return { ok: true, dataUrl: await compress(file) };
  } catch (e) {
    return { ok: false, msg: `图片处理失败：${String(e).replace(/^Error:\s*/, "").slice(0, 120)}` };
  }
}
