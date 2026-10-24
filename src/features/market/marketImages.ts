/**
 * P99b-N3：市场图片的**策略层**（格式白名单、尺寸上限、并发排队、缓存）。
 *
 * 为什么单独一层（§8-48 同族）：卡片、详情轮播、大图三处都要同一套判断。
 * 写在组件里就是三份抄本——而且 vitest 里没有 RTL，组件里的逻辑测不到，测不到就等于没守卫。
 *
 * 三条刻意的"不宽松"：
 *  1. **mime 白名单放行 png/jpeg/webp/gif，SVG 明确拒**：SVG 是脚本容器，就算 `<img>` 里不执行，
 *     放行它等于给"货架上的图"开一条格式后门；而且 200 + `text/html` 正是代理错误页的形状
 *     （参照物那条"拒收伪装成 200 的页面"），所以**状态码不够，必须看格式**。
 *  2. **尺寸超限就不显示**，并说清是"12000×3000 超过单边 8192"，不是"图坏了"——两种话术指向两种修法。
 *     量尺寸只解图片头部（PNG IHDR / GIF LSD / WebP VP8/VP8L/VP8X / JPEG SOF），
 *     **解不出来就照实放行**（unknown ≠ 不兼容，与参照物"只隐藏确认不匹配的"同一条诚实原则）。
 *  3. **缓存淘汰是允许的，但淘汰不等于失败**：被踢出去的那张再问就是重取，不报坏。
 */
import { mimeAllowed, oversizeText, readImageDims } from "./imageHeads";
import { fetchImage } from "./marketStore";

/** 同时最多取几张图：不排队就是首屏几十张 4 MiB 一起打出去 */
export const IMAGE_CONCURRENCY = 3;
/** 缓存张数上限（LRU）。一张最多 4 MiB，24 张是"够用且不至于吃内存"的量级 */
export const IMAGE_CACHE_MAX = 24;

export type ImageStatus = "idle" | "loading" | "ok" | "too_big" | "bad_format" | "failed";

export interface ImageSlot {
  url: string;
  status: ImageStatus;
  /** 只有 ok 才有：超限/格式不符都不留字节，免得为一张不显示的图占着内存 */
  dataUrl: string;
  msg: string;
  w: number;
  h: number;
}

const IDLE: ImageSlot = { url: "", status: "idle", dataUrl: "", msg: "", w: 0, h: 0 };

const slots = new Map<string, ImageSlot>();
const inflight = new Map<string, Promise<ImageSlot>>();
const order: string[] = [];
let running = 0;
const waiters: Array<() => void> = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

export function subscribeMarketImages(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/**
 * 稳定引用：`useSyncExternalStore` 每轮拿到新对象会当成"变了"而无限重渲染，
 * 所以没取过的 url 一律回同一枚 IDLE（url 由组件自己的 prop 决定，不必塞回来）。
 */
export function marketImageSlot(url: string): ImageSlot {
  if (!url) return IDLE;
  return slots.get(url) ?? IDLE;
}

function put(slot: ImageSlot): ImageSlot {
  slots.set(slot.url, slot);
  return slot;
}

/** LRU：新取的排到最后，超上限时把最前面的踢掉（踢掉≠失败，再问就是重取） */
function touch(url: string): void {
  const i = order.indexOf(url);
  if (i >= 0) order.splice(i, 1);
  order.push(url);
  while (order.length > IMAGE_CACHE_MAX) {
    const old = order.shift();
    if (old) {
      slots.delete(old);
      inflight.delete(old);
    }
  }
}

/** 判定与写缓存：单独拆出来是为了能直接测（不用真起网络） */
export function judgeImage(url: string, mime: string, dataUrl: string): ImageSlot {
  if (!mimeAllowed(mime)) {
    return put({ url, status: "bad_format", dataUrl: "", w: 0, h: 0, msg: `服务端说它是「${mime || "(空 mime)"}」，不是放行的位图格式（png/jpeg/webp/gif），已按失败处理` });
  }
  const dims = readImageDims(dataUrl);
  const over = oversizeText(dims);
  if (over) return put({ url, status: "too_big", dataUrl: "", w: dims?.w ?? 0, h: dims?.h ?? 0, msg: over });
  touch(url);
  return put({ url, status: "ok", dataUrl, w: dims?.w ?? 0, h: dims?.h ?? 0, msg: dims ? "" : "没在头部读到尺寸，照实显示（不猜它坏）" });
}


/** 排队：并发上限就在这儿，不在组件里 */
async function queued<T>(job: () => Promise<T>): Promise<T> {
  while (running >= IMAGE_CONCURRENCY) {
    await new Promise<void>((r) => waiters.push(r));
  }
  running++;
  try {
    return await job();
  } finally {
    running--;
    const next = waiters.shift();
    if (next) next();
  }
}

/** 唯一取图入口（卡片/轮播/大图都走它，同一 url 只会在飞一次） */
export function loadImage(url: string): Promise<ImageSlot> {
  if (!url) return Promise.resolve(IDLE);
  const have = slots.get(url);
  if (have && (have.status === "ok" || have.status === "too_big" || have.status === "bad_format")) {
    touch(url);
    return Promise.resolve(have);
  }
  const fly = inflight.get(url);
  if (fly) return fly;
  put({ url, status: "loading", dataUrl: "", msg: "", w: 0, h: 0 });
  emit();
  const p = queued(async () => {
    const r = await fetchImage(url);
    if (!r.ok) return put({ url, status: "failed", dataUrl: "", msg: r.msg || "取回失败（原因未给出）", w: 0, h: 0 });
    return judgeImage(url, r.mime, r.dataUrl);
  })
    .then((slot) => {
      inflight.delete(url);
      emit();
      return slot;
    })
    .catch((e) => {
      const slot = put({ url, status: "failed", dataUrl: "", msg: e instanceof Error ? e.message : String(e), w: 0, h: 0 });
      inflight.delete(url);
      emit();
      return slot;
    });
  inflight.set(url, p);
  return p;
}

/** 一轮渲染该取哪些图：去重、保序（先看到的先出图），空串不算一条 */
export function planImageLoads(urls: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!u || seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/** 自省用（测试与以后的市场状态视图）：不暴露 dataUrl，只说状态 */
export function marketImageReport(): Array<{ url: string; status: ImageStatus; w: number; h: number; msg: string }> {
  return [...slots.values()].map((s) => ({ url: s.url, status: s.status, w: s.w, h: s.h, msg: s.msg }));
}

/** 给单测清场（模块级表在 vitest 里跨用例存活） */
export function __resetMarketImagesForTest(): void {
  slots.clear();
  inflight.clear();
  order.length = 0;
  running = 0;
  waiters.length = 0;
}
