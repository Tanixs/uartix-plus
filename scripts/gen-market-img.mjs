#!/usr/bin/env node
/**
 * P99b-N3：从**主题包自己声明的那些变量**生成预览图（PNG，无新依赖）。
 *
 * 为什么要生成器而不是手画图：预览图说的是"这个包装上大概长什么样"，
 * 手画一张"看着像"的图就是 §8-49 那条的老毛病——**图上画的和包里写的可以各说一套，而没人会红**。
 * 这里每个像素都由 `market/pkg/<主题>` 里的 `--bg/--panel/--text/--text-dim/--accent/--accent-contrast`
 * 算出来，改了主题不重跑，`marketContent.test.ts` 就对账对不上。
 *
 * 两张图各说一件事：
 *  · `-palette.png`   配色本身（bg→panel 渐变 + accent 色带 + 两种文字色的条）
 *  · `-ui-sketch.png` 这些颜色放到界面骨架上的大致观感（**是示意，不是运行截图**，所以界面里叫「预览图」）
 *
 * 用法：`node scripts/gen-market-img.mjs`（或 `npm run market:img`）；`--check` 只比对不写盘。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PKG_DIR = path.join(ROOT, "market", "pkg");
const OUT_DIR = path.join(ROOT, "public", "market", "img");

/* ---------------- PNG 编码（真格式，不是"改个后缀的位图"） ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** rgb: 每像素 3 字节的行主序缓冲 */
export function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 3 + 1);
    raw[rowStart] = 0; // filter: none
    rgb.copy(raw, rowStart + 1, y * width * 3, (y + 1) * width * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------------- 颜色：只认包里写的 hex，认不出来就构建失败 ---------------- */

export function parseHex(s) {
  const t = String(s ?? "").trim().toLowerCase();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(t);
  if (!m) throw new Error(`颜色认不出来：${JSON.stringify(s)}（预览图只吃 #rgb/#rrggbb）`);
  const h = m[1];
  const hex = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}
const mix = (a, b, t) => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
];

class Canvas {
  constructor(w, h, bg) {
    this.w = w;
    this.h = h;
    this.buf = Buffer.alloc(w * h * 3);
    this.fill(0, 0, w, h, bg);
  }
  set(x, y, c) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    this.buf[i] = c[0];
    this.buf[i + 1] = c[1];
    this.buf[i + 2] = c[2];
  }
  fill(x, y, w, h, c) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c);
  }
  /** 横向渐变：两端都是包里的真颜色，中间是算出来的 */
  gradX(x, y, w, h, from, to) {
    for (let i = 0; i < w; i++) {
      const c = mix(from, to, w === 1 ? 0 : i / (w - 1));
      for (let j = 0; j < h; j++) this.set(x + i, y + j, c);
    }
  }
}

/** 主题包 → 那六个变量（少一个就报错：宁可构建失败，也不画一张"猜出来的"图） */
function themeVarsOf(pkgPath) {
  const manifest = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const art = Object.values(manifest.artifacts ?? {})[0];
  if (!art || art.kind !== "theme" || !art.vars) throw new Error(`${pkgPath}: 不是带 vars 的主题包`);
  const need = ["--bg", "--bg-panel", "--text", "--text-dim", "--accent", "--on-accent"];
  const miss = need.filter((k) => !art.vars[k]);
  if (miss.length) throw new Error(`${pkgPath}: 缺变量 ${miss.join("、")}（预览图不许用默认色补）`);
  return { order: need.map((k) => [k, parseHex(art.vars[k])]) };
}

export function renderPalette(vars) {
  const v = Object.fromEntries(vars.order);
  const c = new Canvas(320, 180, v["--bg"]);
  c.gradX(0, 0, 320, 118, v["--bg"], v["--bg-panel"]);
  c.fill(0, 118, 320, 10, v["--accent"]);
  c.fill(0, 128, 320, 10, v["--on-accent"]);
  // 两条文字色：放在 bg 上，看的就是"这个主题里正文/次要文字到底长什么样"
  c.fill(0, 146, 200, 8, v["--text"]);
  c.fill(0, 158, 200, 8, v["--text-dim"]);
  c.fill(216, 146, 104, 20, v["--bg-panel"]);
  return encodePng(c.w, c.h, c.buf);
}

export function renderUiSketch(vars) {
  const v = Object.fromEntries(vars.order);
  const c = new Canvas(480, 270, v["--bg"]);
  c.fill(0, 0, 480, 30, v["--bg-panel"]);
  c.fill(0, 30, 112, 240, mix(v["--bg-panel"], v["--bg"], 0.35));
  c.fill(12, 44, 88, 8, v["--text"]);
  c.fill(12, 60, 70, 8, v["--text-dim"]);
  c.fill(12, 76, 76, 8, v["--text-dim"]);
  // 内容区两块面板 + 一条主按钮色：这就是"装完之后大致这个观感"的意思
  c.fill(128, 46, 336, 92, v["--bg-panel"]);
  c.fill(140, 60, 200, 10, v["--text"]);
  c.fill(140, 78, 300, 8, v["--text-dim"]);
  c.fill(140, 92, 260, 8, v["--text-dim"]);
  c.fill(140, 112, 84, 18, v["--accent"]);
  c.fill(128, 150, 336, 92, mix(v["--bg-panel"], v["--bg"], 0.5));
  c.fill(140, 164, 160, 10, v["--text"]);
  c.fill(140, 182, 300, 8, v["--text-dim"]);
  c.fill(140, 196, 240, 8, v["--text-dim"]);
  return encodePng(c.w, c.h, c.buf);
}

/** 一个主题包 → 两张图（文件名固定，索引条目按同名引用） */
export function imagesFor(pkgPath) {
  const vars = themeVarsOf(pkgPath);
  const slug = path.basename(pkgPath).replace(/\.uartix\.json$/, "").replace(/[^a-z0-9-]/gi, "-");
  return [
    [`${slug}-palette.png`, renderPalette(vars)],
    [`${slug}-ui-sketch.png`, renderUiSketch(vars)],
  ];
}

export function buildAll() {
  const out = [];
  for (const f of fs.readdirSync(PKG_DIR).filter((x) => x.endsWith(".uartix.json")).sort()) {
    const manifest = JSON.parse(fs.readFileSync(path.join(PKG_DIR, f), "utf8"));
    const art = Object.values(manifest.artifacts ?? {})[0];
    if (!art || art.kind !== "theme") continue;
    for (const [name, buf] of imagesFor(path.join(PKG_DIR, f))) out.push([name, buf]);
  }
  return out;
}

function main() {
  const check = process.argv.includes("--check");
  const items = buildAll();
  if (items.length === 0) throw new Error("market/pkg 里没有主题包：宁可构建失败，也不发布一个没图的货架");
  if (!check) fs.mkdirSync(OUT_DIR, { recursive: true });
  let changed = 0;
  for (const [name, buf] of items) {
    const p = path.join(OUT_DIR, name);
    const same = fs.existsSync(p) && Buffer.compare(fs.readFileSync(p), buf) === 0;
    if (!same) {
      changed++;
      if (check) console.log(`图与包不一致，需要重跑生成器：public/market/img/${name}`);
      else fs.writeFileSync(p, buf);
    }
  }
  console.log(`${check ? "检查" : "写出"} ${items.length} 张预览图${check ? `，${changed} 张与包不一致` : ""}`);
  if (check && changed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
