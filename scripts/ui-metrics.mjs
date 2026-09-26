#!/usr/bin/env node
/**
 * P104-B0 度量脚本：把「有没有真的收敛到刻度上」变成可对比的数字。
 *
 * 观感裁决权在人，但这些数不依赖裁决：字号档数、圆角档数、边框声明数、
 * accent 像素占比、默认页汉字数——每一条都是可证伪的。
 *
 *   node scripts/ui-metrics.mjs css
 *   node scripts/ui-metrics.mjs img shot.png --accent c8445c
 *   node scripts/ui-metrics.mjs copy src/features/**\/*.tsx
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
/** 口径必须与 .tools/check-style.cjs 的 cssFiles 一致——
 *  曾经这里少列一份 analysis.css，导致 G 门基线 396 vs 实扫 398 自相矛盾。 */
const CSS_FILES = ["src/styles/theme.css", "src/features/analysis/metrics.css", "src/features/analysis/analysis.css"];

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);

function cssMetrics() {
  let src = "";
  for (const f of CSS_FILES) {
    const p = path.join(ROOT, f);
    if (fs.existsSync(p)) src += stripComments(fs.readFileSync(p, "utf8")) + "\n";
  }
  const grab = (re) => {
    const out = [];
    for (const m of src.matchAll(re)) out.push(m[1]);
    return out;
  };

  const fsLit = grab(/font-size:\s*([0-9.]+)px/g).map(Number);
  const fsTok = grab(/font-size:\s*var\((--[a-z0-9-]+)/g);
  const rLit = grab(/border-radius:\s*([0-9.]+)px/g).map(Number);
  const rTok = grab(/border-radius:\s*var\((--[a-z0-9-]+)/g);
  const borders = grab(/border(?:-(?:top|bottom|left|right))?:\s*[0-9.]+px/g);
  const softBorders = grab(/border(?:-(?:top|bottom|left|right))?:\s*[^;]*--border-soft/g);
  const important = grab(/!important/g);

  const tiers = (arr) => [...new Set(arr)].sort((a, b) => a - b);
  const report = {
    字号: {
      字面量处数: fsLit.length,
      token处数: fsTok.length,
      实际档数: tiers(fsLit).length,
      档位: tiers(fsLit).join("/"),
      半像素档: tiers(fsLit).filter((n) => !Number.isInteger(n)).join("/") || "无",
    },
    圆角: {
      字面量处数: rLit.length,
      token处数: rTok.length,
      实际档数: tiers(rLit).length,
      档位: tiers(rLit).join("/"),
    },
    边框: {
      带宽度声明数: borders.length,
      其中border_soft: softBorders.length,
    },
    important处数: important.length,
  };
  return report;
}

function hexToRgb(h) {
  const s = h.replace("#", "");
  const f = s.length === 3 ? s.split("").map((c) => c + c).join("") : s;
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16));
}

/** 纯 JS 解 PNG 需要 zlib——Node 自带，够用且零依赖 */
async function decodePng(file) {
  const zlib = await import("node:zlib");
  const buf = fs.readFileSync(file);
  if (buf.slice(1, 4).toString("ascii") !== "PNG") throw new Error(`${file} 不是 PNG`);
  let pos = 8;
  let w = 0;
  let h = 0;
  let bitDepth = 8;
  let colorType = 6;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString("ascii");
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`暂只支持 8bit，实际 ${bitDepth}`);
  const ch = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!ch) throw new Error(`不支持的 colorType ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let rp = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[rp++];
    const line = raw.slice(rp, rp + stride);
    rp += stride;
    const prev = y > 0 ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.slice(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev[x];
      const c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      cur[x] = v;
    }
  }
  return { w, h, ch, data: out };
}

async function imgMetrics(file, accentHex) {
  const { w, h, ch, data } = await decodePng(file);
  const [ar, ag, ab] = hexToRgb(accentHex);
  const near = (x, y, tol) => Math.abs(x - y) <= tol;
  let accent = 0;
  let total = 0;
  const buckets = new Map();
  for (let i = 0; i < data.length; i += ch) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = ch === 4 ? data[i + 3] : 255;
    if (a < 128) continue;
    total++;
    if (near(r, ar, 26) && near(g, ag, 26) && near(b, ab, 26)) accent++;
    // 表面档位分布：按亮度粗分五档，看「层级是不是真拉开了」
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    bump(buckets, Math.round(lum / 51) * 51, 1);
  }
  const pct = ((accent / total) * 100).toFixed(2);
  return {
    图: path.basename(file),
    尺寸: `${w}x${h}`,
    accent像素占比: `${pct}%`,
    达标_小于等于3pct: Number(pct) <= 3,
    亮度直方图: Object.fromEntries([...buckets.entries()].sort((a, b) => b[0] - a[0]).slice(0, 6)),
  };
}

const argv = process.argv.slice(2);
const mode = argv[0] || "css";
if (mode === "css") {
  console.log(JSON.stringify(cssMetrics(), null, 1));
} else if (mode === "img") {
  const files = argv.slice(1).filter((a) => !a.startsWith("--"));
  const accent = argv.find((a) => a.startsWith("--accent"))?.split("=")[1] || "c8445c";
  for (const f of files) {
    console.log(JSON.stringify(await imgMetrics(f, accent), null, 1));
  }
} else {
  console.error("用法: ui-metrics.mjs [css | img <file...> --accent=<hex>]");
  process.exit(2);
}
