/**
 * P131-C：AI 的**临时资产层**（`asset_put` 写进来的那批贴图/噪声）。
 *
 * 与 `styleScratch` 同一族性质：只在内存里、可一键撤、**不落盘**。
 * 为什么单独一层而不是塞进主题包那条链：模型现在是"先看一眼效果再决定要不要存成插件"，
 * 存包是另一个动作（`save_theme_extension`，要过能力门）。资产跟着 CSS 草稿走，
 * 撤销草稿时资产一起走，才不会留下"CSS 撤了、变量还挂着"的半截状态。
 */
import { ROOT_LAYER } from "../../styles/rootVars";
import { assetVarName, base64ByteLength, validateAsset, type ThemeAsset } from "../styles/assetGuard";
import { clearAssetLayer, syncAssetLayer } from "../ai/assetRuntime";

export const SCRATCH_ASSET_LAYER_ID = "agent-assets";

const store = new Map<string, ThemeAsset>();
const listeners = new Set<() => void>();

function emit(): void {
  syncAssetLayer(SCRATCH_ASSET_LAYER_ID, ROOT_LAYER.agentAssets, [...store.values()]);
  for (const cb of listeners) cb();
}

export function subscribeScratchAssets(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export interface PutResult {
  ok: boolean;
  /** 拒绝理由（校验器原话，不翻译一遍——翻译会漂） */
  problems: string[];
  /** 成功时给出该在 CSS 里写的那个变量名 */
  varName?: string;
  /** 真能用上的枚数（环境不支持 blob 时会小于成功写入数） */
  live: number;
}

/** 放一枚资产进草稿层。校验走与装包**同一个** `validateAsset`——不给模型一条更松的门 */
export function putScratchAsset(a: unknown): PutResult {
  const problems = validateAsset(a);
  if (problems.length) return { ok: false, problems, live: store.size };
  const rec = a as ThemeAsset;
  store.set(rec.id, { id: rec.id, mime: rec.mime, data: rec.data });
  emit();
  return { ok: true, problems: [], varName: assetVarName(rec.id), live: store.size };
}

export function dropScratchAsset(id: string): boolean {
  const had = store.delete(id);
  if (had) emit();
  return had;
}

export function listScratchAssets(): { id: string; mime: string; bytes: number; varName: string }[] {
  return [...store.values()].map((a) => ({
    id: a.id,
    mime: a.mime,
    bytes: base64ByteLength(a.data),
    varName: assetVarName(a.id),
  }));
}

/** 存包要用的原始记录（`save_theme_extension` / `style_commit` 把它带进产物的 `assets`） */
export function scratchAssetRecords(): ThemeAsset[] {
  return [...store.values()].map((a) => ({ id: a.id, mime: a.mime, data: a.data }));
}

/** 撤销全部草稿资产（与 `revertAll` 的 CSS 那一半配套） */
export function revertScratchAssets(): number {
  const n = store.size;
  store.clear();
  clearAssetLayer(SCRATCH_ASSET_LAYER_ID);
  for (const cb of listeners) cb();
  return n;
}

export function scratchAssetCount(): number {
  return store.size;
}
