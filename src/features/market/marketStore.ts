/**
 * P99b-N1：市场状态（索引拉取、缓存策略、收藏；与本地库的对照放在 `compareInstall`，本机版本由调用方给）。
 *
 * 三条刻意设计，都来自参照物的工程判断而不是我的偏好：
 *  1. **不内置快照兜底**：拉不到就是拉不到（`status:"failed"` + 真实原因 + 耗时），
 *     不把上一份清单当"现状"显示——对每天增长的货架，过期答案不是降级而是错误。
 *  2. **不自动联网**：只有用户打开市场页（或点 Retry）才发请求；启动路径零外发（"never phones home"）。
 *  3. **同源与远程分两条路**：应用自带的示例索引用 webview `fetch`（本来就在包里，不经 Rust 白名单），
 *     任何**外部** URL 一律走 `market_fetch`（https + 域白名单 + 硬字节上限 + 拒重定向）。
 *     这条区分是有意的：把自家包文件也塞进白名单，白名单就变成"什么都能进"的样子。
 */
import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getSnapshot as getSettings } from "../settings/settingsStore";
import {
  MARKET_IMAGE_MAX_BYTES, MARKET_INDEX_MAX_BYTES, MARKET_PKG_MAX_BYTES,
  hostAllowed, isBundledPath, parseMarketIndex, urlHost, MARKET_ALLOW_HOSTS,
  type MarketEntry, type MarketIndex,
} from "./marketIndex";

const FAV_KEY = "uartix.market.fav.v1";

export type MarketStatus = "idle" | "loading" | "ready" | "failed";

export interface MarketState {
  status: MarketStatus;
  index: MarketIndex | null;
  /** 本次成功拉取的时刻与耗时；失败时 error 带原因与耗时 */
  fetchedAt: number;
  elapsedMs: number;
  error: string;
  /** 用了镜像时记下实际地址前缀，界面要说"走的镜像" */
  viaMirror: boolean;
  favorites: string[];
  /**
   * 本机版本：详情/卡片用它判"确认装不上"（Q5 只有确认不兼容才灰显）。
   * 空串＝拿不到（dev 环境或 `@tauri-apps/api/app` 不可用），此时一律 unknown，不猜。
   */
  appVersion: string;
}

let state: MarketState = {
  status: "idle",
  index: null,
  fetchedAt: 0,
  elapsedMs: 0,
  error: "",
  viaMirror: false,
  favorites: loadFavorites(),
  appVersion: "",
};
const listeners = new Set<() => void>();

function emit(): void {
  state = { ...state, favorites: [...state.favorites] };
  for (const fn of listeners) fn();
}

function loadFavorites(): string[] {
  // 收藏是浏览器态：非 DOM 环境（node 侧脚本、契约测试）里没有 localStorage，不该因此炸模块加载
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(FAV_KEY);
    const arr: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    // 收藏读不出来不是世界末日，但也不能静默：下一次保存会覆盖它，所以要出声
    console.warn("[market] 收藏列表解析失败，按空处理（原值保留在 localStorage 里未清）");
    return [];
  }
}

function saveFavorites(list: string[]): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(list));
  } catch {
    console.warn("[market] 收藏写不进 localStorage（容量或隐私模式）");
  }
}

export function subscribeMarket(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getMarketSnapshot(): MarketState {
  return state;
}

export function useMarket(): MarketState {
  return useSyncExternalStore(subscribeMarket, getMarketSnapshot, getMarketSnapshot);
}

/** 镜像前缀必须 https + 以 / 结尾，且它自己的域要在白名单内（否则镜像就是绕闸的后门） */
export function applyMirror(u: string): string | null {
  const raw = getSettings().marketMirrorPrefix.trim();
  if (!raw) return null;
  const prefix = raw.endsWith("/") ? raw : `${raw}/`;
  if (!/^https:\/\//i.test(prefix)) {
    console.warn(`[market] 镜像前缀不是 https，已忽略：${prefix}`);
    return null;
  }
  const host = urlHost(prefix);
  if (!hostAllowed(host, MARKET_ALLOW_HOSTS)) {
    console.warn(`[market] 镜像前缀的域不在白名单，已忽略：${host}`);
    return null;
  }
  return `${prefix}${u.replace(/^https?:\/\//, "")}`;
}

function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 取回一段文本（索引或包）。同源走 fetch，外部走 Rust 白名单通道，失败可退镜像。 */
async function fetchText(url: string, maxBytes: number, kind: string): Promise<{ text: string; sha256: string; elapsedMs: number; viaMirror: boolean; error: string }> {
  const startedAt = Date.now();
  const attempt = async (target: string, viaMirror: boolean): Promise<{ text: string; sha256: string; viaMirror: boolean }> => {
    if (isBundledPath(target)) {
      const res = await fetch(target);
      if (!res.ok) throw new Error(`${kind}返回 ${res.status}`);
      const buf = await res.arrayBuffer();
      if (buf.byteLength > maxBytes) throw new Error(`${kind}超过 ${maxBytes} 字节上限`);
      return { text: new TextDecoder().decode(buf), sha256: "", viaMirror };
    }
    const r = await invoke<{ data: string; sha256: string; bytes: number; elapsedMs: number }>("market_fetch", {
      url: target,
      allowHosts: MARKET_ALLOW_HOSTS,
      maxBytes,
      proxy: getSettings().aiProxy || null,
      noProxy: getSettings().aiNoProxy || null,
    });
    if (maxBytes > 0 && r.bytes > maxBytes) throw new Error(`${kind}超过 ${maxBytes} 字节上限`);
    return { text: new TextDecoder().decode(decodeB64(r.data)), sha256: r.sha256, viaMirror };
  };
  try {
    const hit = await attempt(url, false);
    return { ...hit, elapsedMs: Date.now() - startedAt, viaMirror: false, error: "" };
  } catch (e1) {
    // 包内文件不认镜像：它本来就在应用里，"取不到"是安装坏了，不是网络不通，换地址只会把真因盖掉
    const mirror = isBundledPath(url) ? null : applyMirror(url);
    if (!mirror || mirror === url) {
      return { text: "", sha256: "", elapsedMs: Date.now() - startedAt, viaMirror: false, error: String(e1 instanceof Error ? e1.message : e1) };
    }
    try {
      const hit = await attempt(mirror, true);
      // 直连失败要走镜像时，原因要说全：用户需要知道"直连为什么不行"，不然镜像成了唯一真相
      console.warn(`[market] 直连失败改走镜像：${e1 instanceof Error ? e1.message : String(e1)}`);
      return { ...hit, elapsedMs: Date.now() - startedAt, viaMirror: true, error: "" };
    } catch (e2) {
      return {
        text: "",
        sha256: "",
        elapsedMs: Date.now() - startedAt,
        viaMirror: true,
        error: `直连：${e1 instanceof Error ? e1.message : String(e1)}｜镜像：${e2 instanceof Error ? e2.message : String(e2)}`,
      };
    }
  }
}

/** 本机版本只读一次：拿不到就一直是空串，`compat` 据此回 unknown（不拿"大概是 0.4.x"糊上去） */
let appVersionCache: string | null = null;
async function readAppVersion(): Promise<string> {
  if (appVersionCache !== null) return appVersionCache;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    appVersionCache = (await getVersion()) ?? "";
  } catch {
    console.warn("[market] 拿不到本机版本（非 Tauri 环境）：适配性一律按 unknown 显示");
    appVersionCache = "";
  }
  return appVersionCache;
}

/** 拉索引。失败**不**保留旧清单为"现状"（§0 那条工程判断）。 */
export async function refreshIndex(): Promise<MarketState> {
  const url = getSettings().marketIndexUrl.trim() || "/market/index.json";
  state = { ...state, status: "loading", error: "", appVersion: await readAppVersion() };
  emit();
  const r = await fetchText(url, MARKET_INDEX_MAX_BYTES, "索引");
  if (r.error) {
    state = { ...state, status: "failed", index: null, error: `拉不到索引（${(r.elapsedMs / 1000).toFixed(1)} s）：${r.error}`, elapsedMs: r.elapsedMs, viaMirror: r.viaMirror, fetchedAt: 0 };
    emit();
    return state;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.text);
  } catch (e) {
    state = { ...state, status: "failed", index: null, error: `索引不是合法 JSON：${e instanceof Error ? e.message : String(e)}`, elapsedMs: r.elapsedMs };
    emit();
    return state;
  }
  const res = parseMarketIndex(parsed, isBundledPath(url) ? [...MARKET_ALLOW_HOSTS, "localhost"] : MARKET_ALLOW_HOSTS);
  if (!res.ok) {
    state = { ...state, status: "failed", index: null, error: res.errors.join("；"), elapsedMs: r.elapsedMs };
    emit();
    return state;
  }
  state = { ...state, status: "ready", index: res.index, error: "", elapsedMs: r.elapsedMs, fetchedAt: Date.now(), viaMirror: r.viaMirror };
  emit();
  return state;
}

/**
 * 取包体：先比 sha256，再比字节数——**镜像也不能换内容**，过不了就不入库。
 * 字节数这条不是洁癖：货架写 2 KB、实际给 2 MB 是另一回事（"给你的"和"写着的"必须同一件），
 * 而且装链的确认框要显示大小，显示声明值等于骗人。
 */
export async function fetchPackage(
  entry: MarketEntry,
): Promise<{ ok: true; text: string; bytes: number } | { ok: false; msg: string }> {
  const r = await fetchText(entry.packageUrl, MARKET_PKG_MAX_BYTES, "插件包");
  if (r.error) return { ok: false, msg: `下载失败：${r.error}` };
  if (entry.sha256 && r.sha256 && r.sha256 !== entry.sha256) {
    return { ok: false, msg: `包哈希与索引声明不符（期望 ${entry.sha256.slice(0, 12)}…，实际 ${r.sha256.slice(0, 12)}…），已拒绝入库` };
  }
  const bytes = new TextEncoder().encode(r.text).length;
  if (entry.bytes > 0 && bytes !== entry.bytes) {
    return { ok: false, msg: `包字节数与索引声明不符（索引 ${entry.bytes}，实际 ${bytes}），已拒绝入库` };
  }
  return { ok: true, text: r.text, bytes };
}

/** 截图取回（走同一条白名单通道，返回 data URL 或失败原因）。 */
export async function fetchImage(u: string): Promise<{ ok: true; dataUrl: string } | { ok: false; msg: string }> {
  if (isBundledPath(u)) {
    try {
      const res = await fetch(u);
      if (!res.ok) return { ok: false, msg: `返回 ${res.status}` };
      const blob = await res.blob();
      const text = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => reject(new Error("读取失败"));
        fr.readAsDataURL(blob);
      });
      return { ok: true, dataUrl: text };
    } catch (e) {
      return { ok: false, msg: e instanceof Error ? e.message : String(e) };
    }
  }
  try {
    const r = await invoke<{ data: string; contentType: string; bytes: number }>("market_fetch", {
      url: u,
      allowHosts: MARKET_ALLOW_HOSTS,
      maxBytes: MARKET_IMAGE_MAX_BYTES,
      proxy: getSettings().aiProxy || null,
      noProxy: getSettings().aiNoProxy || null,
    });
    const mime = r.contentType.split(";")[0].trim() || "image/png";
    return { ok: true, dataUrl: `data:${mime};base64,${r.data}` };
  } catch (e) {
    return { ok: false, msg: e instanceof Error ? e.message : String(e) };
  }
}

export function toggleFavorite(id: string): { added: boolean } {
  const has = state.favorites.includes(id);
  state = { ...state, favorites: has ? state.favorites.filter((x) => x !== id) : [...state.favorites, id] };
  saveFavorites(state.favorites);
  emit();
  return { added: !has };
}

/** 收藏夹里已经不在架上的条目：一键清掉（参照物那条"entries that leave the catalog can be cleared in one click"） */
export function clearMissingFavorites(): { removed: number } {
  const onShelf = new Set((state.index?.entries ?? []).map((e) => e.id));
  const kept = state.favorites.filter((id) => onShelf.has(id));
  const removed = state.favorites.length - kept.length;
  if (removed > 0) {
    state = { ...state, favorites: kept };
    saveFavorites(kept);
    emit();
  }
  return { removed };
}
