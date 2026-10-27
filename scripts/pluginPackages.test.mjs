/**
 * P174：**仓库里每个插件包都必须过真校验器**。
 *
 * 为什么值得一条门：插件"装不上/列表里看不见"最常见的原因不是宿主坏了，而是清单里某一条
 * 被校验器拒了，而那条错误只在面板顶部一行黄字里出现（用户不会去看，或者看的时候已经滚走了）。
 * 这条门把"仓库自带的插件是否合法"变成每次提交都验的一件事——顺便也验了校验器本身没写歪。
 *
 * 覆盖面：`plugins/` 与 `examples/plugins/` 下所有带 `plugin.json` 的目录。
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MANIFEST_FILE, validateExtension } from "../src/features/plugins/engine/manifest.ts";
import { guardThemeCss } from "../src/features/plugins/engine/themeCss.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

function findPackages(dir) {
  const out = [];
  let ents;
  try {
    ents = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of ents) {
    const p = path.join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    try {
      const mf = readFileSync(path.join(p, MANIFEST_FILE), "utf8");
      out.push({ dir: p, name, raw: mf });
      continue; // 一个包就是一个目录，不往里递归（包内的子目录不是包）
    } catch {
      out.push(...findPackages(p)); // 没清单 ⇒ 可能是分组目录（plugins/ / examples/plugins/）
    }
  }
  return out;
}

function findFiles(dir, re, depth = 0, acc = []) {
  if (depth > 3) return acc;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(p, re, depth + 1, acc);
    else if (re.test(e.name)) acc.push(p);
  }
  return acc;
}

const packages = [...findPackages(path.join(ROOT, "plugins")), ...findPackages(path.join(ROOT, "examples"))];

describe("P174 · 仓库自带的插件包", () => {
  it("至少找得到两个包（找不到就是这条门自己失效了）", () => {
    expect(packages.length).toBeGreaterThanOrEqual(2);
  });

  it("至少有一枚主题真被查过（否则上面那段循环是空转，等于没写）", () => {
    const themes = packages.flatMap((pkg) => {
      try {
        return JSON.parse(pkg.raw).contributes?.themes ?? [];
      } catch {
        return [];
      }
    });
    expect(themes.length, "仓库里的示例包连一枚主题都没有，主题那半条门没被跑过").toBeGreaterThanOrEqual(1);
  });

  for (const pkg of packages) {
    it(`${pkg.name}：${MANIFEST_FILE} 过校验，且目录名 = 清单 id、入口文件都在`, () => {
      let raw;
      expect(() => {
        raw = JSON.parse(pkg.raw);
      }, `${pkg.name} 的 ${MANIFEST_FILE} 不是合法 JSON`).not.toThrow();

      const v = validateExtension(raw);
      // 错误原样贴出来：这条挂了要能一眼看出是哪一条规则拒的
      expect(v.errors, `${pkg.name} 清单不合法：\n- ${v.errors.join("\n- ")}`).toEqual([]);
      expect(v.ok).toBe(true);

      const m = v.manifest;
      // 目录名必须等于 id：宿主按 id 拼路径，不一致的包里"装上了但点不动"
      expect(pkg.name, `目录名与清单 id（${m.id}）不一致`).toBe(m.id);

      if (m.main) expect(() => statSync(path.join(pkg.dir, m.main)), `缺入口 ${m.main}`).not.toThrow();
      // 包内每个 .mjs 都要过语法门：一个 `/** */` 里写出 `*/` 就能让整枚插件静默起不来，
      // 而它的表现是"面板点了没反应"——排查成本极高，所以放在这里当场红。
      for (const f of findFiles(pkg.dir, /\.mjs$/)) {
        let err = "";
        try {
          execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
        } catch (e) {
          err = String(e.stderr || e.message || e).split("\n").slice(0, 4).join("\n");
        }
        expect(err, `语法不过：${path.relative(ROOT, f)}\n${err}`).toBe("");
      }
      for (const panel of m.contributes.panels ?? []) {
        expect(() => statSync(path.join(pkg.dir, panel.entry)), `面板 ${panel.id} 缺入口 ${panel.entry}`).not.toThrow();
      }
      // 主题要过的是**和运行时同一条**判据（`guardThemeCss`），不是"文件在不在"。
      // 只查存在的话，示例包可以一直带着一份会被净化器拒的 CSS，而作者要到装上以后
      // 才在面板顶部那行黄字里发现"主题已跳过"。
      for (const th of m.contributes.themes ?? []) {
        const css = readFileSync(path.join(pkg.dir, th.entry), "utf8");
        const g = guardThemeCss(css, th.entry);
        expect(g.issue, `${pkg.name} 的主题 ${th.id}（${th.entry}）过不了净化`).toBeUndefined();
        expect(g.css?.length ?? 0, `${pkg.name} 的主题 ${th.id} 是空的`).toBeGreaterThan(0);
      }
    });
  }
});
