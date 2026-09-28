/**
 * 门禁自己也要有门禁：`.tools/check-*.cjs` 写好了但忘了接进 `npm run check:all`，
 * 那道门就等于不存在——而且它**永远不会红**，因为没人调它。
 *
 * 这不是假想的事故：`§8-60` 记的就是"六道门一条都扫不到 .github/workflows，
 * 于是发版说明读一个不入库的文件，CI 连挂两轮才发现"。那一轮补的是内容覆盖，
 * 这一条补的是**接线覆盖**：新增一道门而忘了挂链，这里当场红。
 */
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");
const pkg = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8"));
const chain = pkg.scripts["check:all"];

const gates = readdirSync(`${ROOT}.tools`)
  .filter((f) => /^check-.*\.cjs$/.test(f))
  .sort();

describe("check:all 必须真的调用每一道门", () => {
  it(`.tools 下 ${gates.length} 道门全部在链上（少一道就是哑门）`, () => {
    expect(gates.length, "一道门都没扫到？那是这个测试自己瞎了").toBeGreaterThan(5);
    const missing = gates.filter((f) => !chain.includes(`node .tools/${f}`));
    expect(missing, `这些门写好了但没接进 check:all：${missing.join(", ")}`).toEqual([]);
  });

  it("链上引用的门都还存在（删文件不删引用 = check:all 直接崩）", () => {
    const referenced = [...chain.matchAll(/node \.tools\/(check-[\w-]+\.cjs)/g)].map((m) => m[1]);
    const onDisk = new Set(gates);
    const dangling = referenced.filter((f) => !onDisk.has(f));
    expect(dangling, `check:all 还在调已经不存在的门：${dangling.join(", ")}`).toEqual([]);
  });

  it("P117 新加的视口单位门在链上（§19 那条规矩从此有门守着）", () => {
    expect(chain).toContain("node .tools/check-viewport-units.cjs");
  });
});
