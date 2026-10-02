/**
 * P131-C 资产通道的运行期那一半：把结构化资产（base64）变成
 * `--fx-asset-<id>: url("blob:…")` 写进根元素的**内联样式**。
 * 两条来源共用这一个实现：插件/主题包那枚在画的（`theme-assets` 层）与 AI 临时草稿
 * （`agent-assets` 层，见 `agent/scratchAssets.ts`）。
 *
 * 为什么走 blob 而不是把 `data:` 直接写进 CSS：
 *  - 一枚噪声图几百 KB，写进样式表会让每次合成都重新解析那串 base64；
 *  - blob URL 可回收——停用主题 / 撤销草稿时 `revokeObjectURL`，不留一堆活对象；
 *  - 内联样式压得过样式表，所以 `--fx-asset-*` 这一族变量**只有这里写得进去**
 *    （净化器放行 `url(var(--fx-asset-*))` 的前提就是这句话成立）。
 *
 * 校验不在这里做：装包时 `validateAssetList` 已经过了一遍（mime 白名单 + 魔数 + 尺寸 +
 * SVG 脚本面）。这里只负责"变成能用的 URL"，解码失败就跳过那一枚并把数报出去，不画半张图。
 */
import { ROOT_LAYER, submitRootVars, dropRootVars } from "../../styles/rootVars";
import { assetVarName, decodeBase64, type ThemeAsset } from "../styles/assetGuard";

export const ASSET_LAYER_ID = "theme-assets";

/** 一层资产的活体记录：id → {指纹, URL} */
type Live = Map<string, { key: string; url: string }>;
const liveOf = new Map<string, Live>();

/**
 * 指纹要覆盖**整串**内容：只取长度 + 头尾的话，"中间换一个字节"的两张贴图会算成同一枚，
 * 于是换了主题还留着上一张的 URL——那正是"屏幕上那张噪声是谁给的"说不清的那种 bug。
 * FNV-1a：无依赖、确定性、够用（这里要的是"变没变"，不是密码学哈希）。
 */
function fingerprint(a: ThemeAsset): string {
  let h = 0x811c9dc5;
  const s = a.data;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${a.mime}:${s.length}:${h.toString(16)}`;
}

function createBlobUrl(bytes: Uint8Array, mime: string): string | null {
  if (typeof Blob === "undefined" || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  try {
    return URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: mime }));
  } catch {
    return null;
  }
}

function revoke(url: string): void {
  try {
    if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(url);
  } catch {
    /* 回收失败不影响正确性：那条 URL 已经不在任何变量里了 */
  }
}

/**
 * 让某一层与这批资产一致。返回"这次真能用上的枚数"——比传进来的少就说明有资产解码失败
 * 或环境不支持 blob，调用方要把这个差值报出去，不许静默。
 */
export function syncAssetLayer(layerId: string, order: number, assets: readonly ThemeAsset[]): number {
  let live = liveOf.get(layerId);
  if (!live) {
    live = new Map();
    liveOf.set(layerId, live);
  }
  const wanted = new Map<string, ThemeAsset>();
  for (const a of assets) if (!wanted.has(a.id)) wanted.set(a.id, a);

  for (const [id, rec] of live) {
    const next = wanted.get(id);
    if (!next || fingerprint(next) !== rec.key) {
      revoke(rec.url);
      live.delete(id);
    }
  }

  const vars: Record<string, string> = {};
  for (const [id, a] of wanted) {
    let url = live.get(id)?.url;
    if (!url) {
      const bytes = decodeBase64(a.data);
      url = bytes ? (createBlobUrl(bytes, a.mime) ?? "") : "";
      if (url) live.set(id, { key: fingerprint(a), url });
    }
    if (url) vars[assetVarName(id)] = `url("${url}")`;
  }

  if (Object.keys(vars).length) submitRootVars(layerId, order, vars);
  else dropRootVars(layerId);
  return Object.keys(vars).length;
}

/** 清掉一层（主题那枚在画的 / AI 的草稿）并回收它的 URL */
export function clearAssetLayer(layerId: string): void {
  const live = liveOf.get(layerId);
  if (live) {
    for (const rec of live.values()) revoke(rec.url);
    live.clear();
  }
  dropRootVars(layerId);
}

/** 在画的主题资产层：`extRuntime` 每次重合成都调它 */
export function syncThemeAssets(assets: readonly ThemeAsset[]): number {
  return syncAssetLayer(ASSET_LAYER_ID, ROOT_LAYER.assets, assets);
}

/** 某一层现在活着几枚（审计与测试读它，不读内部 Map） */
export function assetLayerCount(layerId: string): number {
  return liveOf.get(layerId)?.size ?? 0;
}
