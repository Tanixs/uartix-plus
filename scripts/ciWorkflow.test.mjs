/**
 * P102 发版批：`.github/workflows/` 的守卫（六道门一条都扫不到这里，§8-60 就是这么断的）。
 *
 * v0.5.0 的 CI 第一轮挂在 `create-release` 第一步：`release.yml` 建 release 时读
 * `docs/reports/release-notes/<tag>.md`（该目录 P136 起归档为 `docs/reports/release-notes/`，且早已冻结），
 * 而 `docs/` 自 `539034e` 起按用户裁决**不再入库**。
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
        if (/[("'`]docs\/|\/ docs\/|\bdocs\//.test(line)) hits.push(`${f}: ${line.trim().slice(0, 90)}`);
      }
    }
    expect(hits, `这些行读的是不入库的目录，CI 上必然找不到文件：\n${hits.join("\n")}`).toEqual([]);
  });
});

describe("P102 · 发版正文只有一个出处", () => {  const rel = readFileSync(path.join(ROOT, WF_DIR, "release.yml"), "utf8");

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

/* ================= P118：门禁自己得在 CI 里跑 =================
 * 这一批之前，`.github/workflows` 里 grep `check:` / `vitest` / `tsc` 是 **0 处**：
 * 11 道门与 1800 多条测试只在本地由当值会话自觉执行。"这批全绿"因此不可审计、
 * 也不可强制——漏跑一次没人知道，而 §8-60 那次付账（发版说明读不入库的目录，
 * CI 连挂两轮）说的正是同一件事：**没人检查的约定早晚会烂**。
 */
describe("P118 · CI 必须真的跑门禁与测试", () => {
  const all = files.map((f) => [f, readFileSync(path.join(ROOT, WF_DIR, f), "utf8")]);
  const joined = all.map(([, s]) => s).join("\n");

  it("至少有一份 workflow 跑 check:all（否则十道门是本地荣誉）", () => {
    const runners = all.filter(([, s]) => /npm run check:all/.test(s)).map(([f]) => f);
    expect(runners.length, "没有任何 workflow 跑 check:all：门禁只能在本地自觉").toBeGreaterThan(0);
  });

  it("至少有一份跑 vitest，且跑 tsc", () => {
    expect(/vitest/.test(joined), "CI 不跑测试 ⇒ 1800 条断言在远端一文不值").toBe(true);
    expect(/tsc --noEmit/.test(joined), "CI 不查类型 ⇒ 类型错误要到发版构建才炸").toBe(true);
  });

  it("ci.yml 只读：不发布、不写产物、不碰密钥", () => {
    const ci = readFileSync(path.join(ROOT, WF_DIR, "ci.yml"), "utf8");
    expect(/contents: read/.test(ci), "CI 需要写权限吗？发版是 release.yml 的活").toBe(true);
    expect(/secrets\./.test(ci), "CI 里出现了 secrets —— 每个 fork/PR 都能读到，别顺手接密钥").toBe(false);
    expect(/gh release|createRelease|uploads\.github/.test(ci), "CI 不该顺手发布").toBe(false);
  });

  it("标签推送到 v* 时由 release.yml 负责，ci.yml 明确让开（避免同一次发版跑两遍）", () => {
    const ci = readFileSync(path.join(ROOT, WF_DIR, "ci.yml"), "utf8");
    expect(/tags-ignore/.test(ci), "ci.yml 没排除 tag：发版会给同一个 tag 跑两套流水线").toBe(true);
  });
});
