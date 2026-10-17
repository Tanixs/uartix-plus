#!/usr/bin/env node
/**
 * P154-A · 第 17 道门：绘画级覆盖率的账本门（静态）。
 *
 * P150 的仪表（paint-coverage.mjs）第一期只点名不设线——"自己给自己打分"的教训是线必须从实测量来。
 * 这道门管的是**账本**：地板必须等于或低于留档实测（不许拍脑袋抬线）、分母自证不能是 0、
 * 对照对写死 fluent/light（换对照 = 重新采数，不许沿用旧地板）。
 * 活体那一半（今天到底有没有掉到地板下）在 `paint-coverage.mjs --check` 里，
 * 两者共用 `paint-coverage-lib.mjs` 的一份判据——这道门自己瞎不瞎，靠下面两条夹具证。
 */
import { existsSync, readFileSync } from "node:fs";
import { judgeAgg, judgeLedger } from "./paint-coverage-lib.mjs";

const LEDGER = new URL("./paint-coverage-baseline.json", import.meta.url);

let fails = 0;
if (!existsSync(LEDGER)) {
  console.error("FAIL(17): 没有 .tools/paint-coverage-baseline.json —— 先跑 node .tools/paint-coverage.mjs --write 起账");
  process.exit(1);
}
const led = JSON.parse(readFileSync(LEDGER, "utf8"));

const shapeBad = judgeLedger(led);
if (shapeBad.length) {
  for (const b of shapeBad) console.error(`FAIL(17): ${b}`);
  fails += shapeBad.length;
}

/** 夹具①：一块全部压线的 agg 必须过（judgeAgg 不是永远红）；②：低一块必须红（也不是永远绿） */
const at = { deltaPct: led.floor.deltaPct, handlePct: led.floor.handlePct, propDeltaPct: led.floor.propDeltaPct, elems: led.floor.elems, faces: Array.from({ length: led.floor.faces }) };
const over = { ...at, deltaPct: led.floor.deltaPct - 0.1 };
if (judgeAgg(at, led, "夹具").length !== 0) {
  console.error("FAIL(17): 夹具①压线的数被判违规 —— judgeAgg 与账本对不上");
  fails++;
} else if (judgeAgg(over, led, "夹具").length !== 1) {
  console.error("FAIL(17): 夹具②低于地板 0.1 个点没被判红 —— 判据是瞎的，OK 不算数");
  fails++;
}

if (fails === 0) {
  console.log(`OK(17): 绘画级覆盖率账本成立 —— ${led.cand} 对 ${led.base}，地板 真变 ${led.floor.deltaPct}% / 有句柄 ${led.floor.handlePct}% / 按属性 ${led.floor.propDeltaPct}%，分母 ${led.floor.elems} × ${led.floor.faces} 面（夹具 2 条全命中）`);
}
process.exit(fails === 0 ? 0 : 1);
