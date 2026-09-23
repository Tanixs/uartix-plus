/**
 * P99b-N3：图片策略层（格式白名单 / 尺寸上限 / 并发 / 缓存）。
 * 最该钉的一件事：**三种"没显示"要分得开**——格式不对、太大、取回坏了。
 * 混成一句"图片加载失败"就把用户的修法删掉了（他以为货架坏了，其实是投稿人传了 SVG）。
 * 夹具用各格式**真实的头部字节**（PNG IHDR / GIF LSD / JPEG SOF0 / WebP VP8X），不是我以为的形状。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const st = vi.hoisted(() => ({
  calls: [] as string[],
  inFlight: 0,
  maxInFlight: 0,
  hold: false,
  release: [] as Array<() => void>,
  res: { ok: true, dataUrl: "", mime: "image/png" } as { ok: boolean; dataUrl?: string; mime?: string; msg?: string },
}));

vi.mock("./marketStore", () => ({
  fetchImage: async (u: string) => {
    st.calls.push(u);
    st.inFlight++;
    st.maxInFlight = Math.max(st.maxInFlight, st.inFlight);
    if (st.hold) await new Promise<void>((r) => st.release.push(r));
    await new Promise<void>((r) => setTimeout(r, 0));
    st.inFlight--;
    return st.res.ok
      ? { ok: true, dataUrl: st.res.dataUrl ?? "", mime: st.res.mime ?? "image/png" }
      : { ok: false, msg: st.res.msg ?? "" };
  },
}));

const { IMAGE_CONCURRENCY, judgeImage, loadImage, marketImageSlot, planImageLoads, __resetMarketImagesForTest } =
  await import("./marketImages");
const { IMAGE_MIME_ALLOW, IMAGE_MAX_EDGE, IMAGE_MAX_PIXELS, readImageDims } =
  await import("./imageHeads");

const asc = (s: string) => [...s].map((c) => c.charCodeAt(0));
/** 往普通数组里写一段 ASCII（Array 没有 .set，别照 TypedArray 的写法抄） */
const put = (b: number[], at: number, s: string) => { b.splice(at, s.length, ...asc(s)); };
const toUrl = (b: number[]) => `data:image/png;base64,${btoa(String.fromCharCode(...b))}`;
const zeros = (n: number) => new Array(n).fill(0);
const be32 = (b: number[], at: number, v: number) => { b[at] = (v >>> 24) & 255; b[at + 1] = (v >>> 16) & 255; b[at + 2] = (v >>> 8) & 255; b[at + 3] = v & 255; };
const be16 = (b: number[], at: number, v: number) => { b[at] = (v >>> 8) & 255; b[at + 1] = v & 255; };
const le16 = (b: number[], at: number, v: number) => { b[at] = v & 255; b[at + 1] = (v >>> 8) & 255; };
const le24 = (b: number[], at: number, v: number) => { b[at] = v & 255; b[at + 1] = (v >>> 8) & 255; b[at + 2] = (v >>> 16) & 255; };

function pngUrl(w: number, h: number): string {
  const b = zeros(48);
  b[0] = 0x89; put(b, 1, "PNG"); b[4] = 0x0d; b[5] = 0x0a; b[6] = 0x1a; b[7] = 0x0a;
  be32(b, 8, 13); put(b, 12, "IHDR"); be32(b, 16, w); be32(b, 20, h);
  return toUrl(b);
}
function gifUrl(w: number, h: number): string {
  const b = zeros(32); put(b, 0, "GIF89a"); le16(b, 6, w); le16(b, 8, h); return toUrl(b);
}
function jpegUrl(w: number, h: number): string {
  const b = zeros(64);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff; b[3] = 0xe0; be16(b, 4, 16); put(b, 6, "JFIF");
  const i = 2 + 2 + 16; // 跳到 APP0 之后
  b[i] = 0xff; b[i + 1] = 0xc0; be16(b, i + 2, 17); b[i + 4] = 8; be16(b, i + 5, h); be16(b, i + 7, w);
  return toUrl(b);
}
function webpUrl(w: number, h: number): string {
  const b = zeros(48);
  put(b, 0, "RIFF"); put(b, 8, "WEBP"); put(b, 12, "VP8X");
  le24(b, 24, w - 1); le24(b, 27, h - 1);
  return toUrl(b);
}

beforeEach(() => {
  __resetMarketImagesForTest();
  st.calls.length = 0;
  st.inFlight = 0;
  st.maxInFlight = 0;
  st.hold = false;
  st.release.length = 0;
  st.res = { ok: true, dataUrl: pngUrl(320, 180), mime: "image/png" };
});

describe("P99b-N3 · 读宽高（只解头部）", () => {
  it("PNG/GIF/JPEG/WebP 四种真实头部都读得出尺寸", () => {
    expect(readImageDims(pngUrl(320, 180))).toEqual({ w: 320, h: 180 });
    expect(readImageDims(gifUrl(640, 480))).toEqual({ w: 640, h: 480 });
    expect(readImageDims(jpegUrl(1920, 1080))).toEqual({ w: 1920, h: 1080 });
    expect(readImageDims(webpUrl(800, 600))).toEqual({ w: 800, h: 600 });
  });

  it("读不出来就是 null，不编一个尺寸出来", () => {
    expect(readImageDims(toUrl(zeros(40)))).toBeNull();
    expect(readImageDims("data:image/png;base64,!!!")).toBeNull();
    expect(readImageDims("")).toBeNull();
  });
});

describe("P99b-N3 · 三种「没显示」分得开", () => {
  it("mime 放行集穷举：位图四种（jpg 算别名）进、SVG 与 html 不进", () => {
    expect([...IMAGE_MIME_ALLOW].sort()).toEqual(["image/gif", "image/jpeg", "image/jpg", "image/png", "image/webp"]);
    for (const ok of ["image/png", "image/jpeg", "image/webp", "image/gif", "IMAGE/PNG"]) {
      expect(judgeImage(`u-${ok}`, ok, pngUrl(20, 20)).status, `${ok} 该放行（大小写也一样）`).toBe("ok");
    }
    for (const bad of ["image/svg+xml", "text/html", "application/octet-stream", ""]) {
      const s = judgeImage("https://raw.githubusercontent.com/a/b/s", bad, pngUrl(10, 10));
      expect(s.status, bad).toBe("bad_format");
      expect(s.dataUrl, "格式不符不许把字节留在内存里").toBe("");
      expect(s.msg).toContain(bad || "(空 mime)");
    }
  });

  it("超限判定用字面量钉（只跟常量比＝常量抬到 10 万也照样绿，那是假守卫）", () => {
    const long = judgeImage("u1", "image/png", pngUrl(12000, 3000));
    expect(long.status, "12000×3000 这种长图必须挡住").toBe("too_big");
    expect(long.msg).toContain("12000×3000");
    expect(long.msg).toContain(String(IMAGE_MAX_EDGE));
    expect(long.dataUrl, "超限的不许把字节留在内存里").toBe("");
    expect(judgeImage("u2", "image/png", pngUrl(6000, 5000)).status, "单边没超但总像素超了也要挡").toBe("too_big");
    expect(judgeImage("u3", "image/png", pngUrl(3840, 2160)).status, "4K 截图必须放行").toBe("ok");
    // 上限本身也得有个量级约束：抬到能挡真截图或低到放行超长图，都算改坏
    expect(IMAGE_MAX_EDGE).toBeGreaterThanOrEqual(4096);
    expect(IMAGE_MAX_EDGE).toBeLessThanOrEqual(12000);
    expect(IMAGE_MAX_PIXELS).toBeGreaterThanOrEqual(8_000_000);
  });

  it("取回失败说的是原因，不伪装成尺寸问题", async () => {
    st.res = { ok: false, msg: "远端返回 404" };
    const s = await loadImage("https://raw.githubusercontent.com/a/b/miss.png");
    expect(s.status).toBe("failed");
    expect(s.msg).toContain("404");
  });
});

describe("P99b-N3 · 排队与缓存", () => {
  it("并发不超上限，同一 url 只飞一次", async () => {
    const ten = Array.from({ length: 10 }, (_, i) => `https://raw.githubusercontent.com/a/b/${i}.png`);
    const all = ten.map(loadImage);
    expect(loadImage(ten[0])).toBe(all[0]); // 同一条 url 不重飞
    await Promise.all(all);
    expect(st.maxInFlight, "并发超了就是首屏卡死的形状").toBeLessThanOrEqual(4);
    expect(IMAGE_CONCURRENCY, "并发上限本身不许被抬成「一起打出去」").toBeLessThanOrEqual(6);
    expect(st.calls.length).toBe(10);
  });

  it("缓存超上限踢最旧的；被踢的那张再问是重取，不是坏", async () => {
    for (let i = 0; i < 26; i++) await loadImage(`https://raw.githubusercontent.com/a/b/${i}.png`);
    expect(st.calls.length).toBe(26);
    const first = await loadImage("https://raw.githubusercontent.com/a/b/0.png");
    expect(first.status, "淘汰后再取应当成功，不该报坏").toBe("ok");
    expect(st.calls.length).toBe(27);
  });

  it("planImageLoads 去重保序，空串不算一条", () => {
    expect(planImageLoads(["a", "b", "a", "", "c"])).toEqual(["a", "b", "c"]);
  });

  it("卡片与大图**同时**问同一 url 只取一次（顺序问会落缓存，测不到在飞去重）", async () => {
    const u = "https://raw.githubusercontent.com/a/b/shared.png";
    st.hold = true;
    // 两个调用都要**先起起来**再放行：先 await 再 release 会互相等死（夹具自己死锁）
    const a = loadImage(u);
    const b = loadImage(u);
    st.release.splice(0).forEach((r) => r());
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe("ok");
    expect(rb.dataUrl).toBe(ra.dataUrl);
    expect(st.calls.filter((x) => x === u).length, "同一张图取了两遍，就是白烧一次 4 MiB").toBe(1);
    expect(marketImageSlot(u).dataUrl).toBe(ra.dataUrl);
  });
});
