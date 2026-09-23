/**
 * P102 发版批：`.github/workflows/` 的守卫（六道门一条都扫不到这里，§8-60 就是这么断的）。
 *
 * v0.5.0 的 CI 第一轮挂在 `create-release` 第一步：`release.yml` 建 release 时读
 * `docs/RELEASE_NOTES/<tag>.md`，而 `docs/` 自 `539034e` 起按用户裁决**不再入库**。
 * 两条裁决各自都对，接缝处没人检查——而 `check:all` 扫的是 `src`，`.github/` 不在任何门里。
 *
 * 所以这里钉两件能被代码反驳的事：
 *  ① workflow 里不许出现指向 `docs/` 的路径（要读就读物化在仓库里的东西）；
 *  ② 发版正文必须从 `CHANGELOG.md` 派生，且**读不到就失败在写副作用之前**
 *     （第一轮那次 jq 失败之后 `gh api --input -` 仍拿空 stdin 跑完，建出了一份没有 tag 的空草稿）。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 裸 `URL` 在这套 eslint 配置下是 no-undef（P99b-N6 踩过同一条），走 import.meta.url 拼仓库根
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WF_DIR = ".github/workflows";
const files = readdirSync(path.join(ROOT, WF_DIR)).filter((f) => /\.ya?ml$/.test(f));

describe("P102 · workflow 不许指向不入库的目录", () => {
  it("至少有一份 workflow（否则这三条测的是空集）", () => {
    expect(files.length, ".github/workflows 下没有 yaml：这条守卫测不到东西").toBeGreaterThan(0);
  });

  it("任何一处 `docs/` 路径都是断链（docs 自 539034e 起停止跟踪）", () => {
    const hits = [];
    for (const f of files) {
      const src = readFileSync(path.join(ROOT, WF_DIR, f), "utf8");
      // 只抓"被当成文件路径读"的 docs/（引号里 / 反引号里 / 紧跟 `/` 的下一级），注释里讲历史不算
      for (const line of src.split("\n")) {
        if (/^\s*(#|\/\/)/.test(line.trim()) || line.includes("# ") && line.indexOf("docs/") > line.indexOf("# ")) continue;
        if (/[("'`]docs\/|\/ docs\/|\bdocs\/RELEASE_NOTES/.test(line)) hits.push(`${f}: ${line.trim().slice(0, 90)}`);
      }
    }
    expect(hits, `这些行读的是不入库的目录，CI 上必然找不到文件：\n${hits.join("\n")}`).toEqual([]);
  });
});

describe("P102 · 发版正文只有一个出处", () => {
  const rel = readFileSync(path.join(ROOT, WF_DIR, "release.yml"), "utf8");

  it("正文从 CHANGELOG.md 派生", () => {
    expect(rel, "release.yml 不再从 CHANGELOG 那一节取正文 ⇒ 又要长出第二个说明文件了").toContain("CHANGELOG.md");
  });

  it("读不到正文必须在建 release 之前失败（副作用顺序）", () => {
    const guard = rel.indexOf('::error::CHANGELOG.md 里找不到');
    const create = rel.indexOf("gh api -X POST");
    expect(guard, "空正文的检查没了：jq/awk 失败也会把半成品建到 Releases 页上").toBeGreaterThan(-1);
    expect(create, "找不到创建 release 那句，这条的顺序比较没意义").toBeGreaterThan(-1);
    expect(guard < create, "正文检查挪到了创建之后 ⇒ 失败会留下一份空草稿（v0.5.0 第一轮就这样）").toBe(true);
  });
});
