/**
 * P111-D：模型清单（`GET {base}/models`）。
 *
 * 这一层存在的理由有两件：
 *  1. **「试连」不该花钱**。旧试连发一次真 completion（内容 "ping"），要等到模型答完
 *     才知道配置对不对——花 token 才能证明"配得对"是设计缺陷，不是实现瑕疵。
 *  2. 有了清单才有 ZCode 那个「刷新模型列表」，以及从 id 后缀**预填**上下文窗口。
 *
 * 刻意不做的事：不猜各家私有路径。`models_url`（Rust 侧）只把 base 上的端点尾巴换成
 * `/models`，拿不到就当这家不开清单端点——404 在这里是**连通性证据**而不是失败。
 */
import { invoke } from "@tauri-apps/api/core";
import { cleanApiKey } from "../agent/provider";
import type { AiProvider } from "./aiProfileStore";

/** 窗口预填的下限/上限：认得出但明显不是窗口的数（`8k` 上下文、`16m`）一律不收 */
const GUESS_MIN = 1024;
const GUESS_MAX = 32_000_000;

/**
 * 从模型 id 猜上下文窗口：`…-128k` → 128000、`…-1m` → 1000000。
 * 取**最靠后**的那个 k/m 段（窗口惯例写在尾巴上：`qwen2.5-coder-32b-instruct-1m`）。
 * 认不出返回 null —— 调用方保留默认值，不编一个数填进去。
 */
export function guessContextTokens(modelId: string): number | null {
  const hits = [...modelId.matchAll(/(\d+(?:\.\d+)?)([km])(?![a-z])/gi)];
  if (!hits.length) return null;
  const last = hits[hits.length - 1];
  const n = Number(last[1]) * (last[2].toLowerCase() === "m" ? 1_000_000 : 1000);
  if (!Number.isFinite(n) || n < GUESS_MIN || n > GUESS_MAX) return null;
  return Math.round(n);
}

/** 拉一家供应商的模型清单；错误原样带回（界面上那一句话要能说出是 401 还是连不上） */
export async function listModels(p: AiProvider): Promise<string[]> {
  return await invoke("ai_list_models", {
    baseUrl: p.baseUrl,
    // 与真实请求同一个清洗点：贴进来的换行/空格会发坏鉴权头（P108 的由来）。
    // `provider.test.ts` 那道"裸 apiKey 出境"守卫就是盯这个的，绕开它当场红。
    apiKey: cleanApiKey(p.apiKey),
    format: p.format,
    proxy: p.proxy || null,
    noProxy: p.noProxy || null,
  });
}

/** 远端有、本地档案里没有的那些。大小写按原样比（模型 id 是区分大小写的） */
export function missingFrom(remote: string[], localIds: string[]): string[] {
  const have = new Set(localIds);
  return remote.filter((r) => !have.has(r));
}
