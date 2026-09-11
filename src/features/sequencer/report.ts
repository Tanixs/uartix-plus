/**
 * 运行报告 → 自包含 HTML（T5）。
 *
 * 纯函数：无 DOM / Node / IPC 依赖，桌面端（面板「导出报告」下载）与
 * CLI（--report 落盘）共用同一份生成器。单文件离线可看，无外部资源与脚本。
 */

import type { RunResult, StepResult, StepStatus } from "./types";

const KIND_ZH: Record<string, string> = {
  send: "发送",
  wait: "等待",
  waitForFrame: "等帧",
  assertVar: "断言",
  note: "备注",
};

const STATUS_ZH: Record<StepStatus, string> = {
  pass: "通过",
  fail: "失败",
  timeout: "超时",
  skipped: "跳过",
  aborted: "中止",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface Stats {
  pass: number;
  bad: number;
  skip: number;
  truncated: boolean;
}

function walkStats(rs: StepResult[], out: Stats): void {
  for (const r of rs) {
    if (r.stepId === "_truncated") out.truncated = true;
    else if (r.status === "pass") out.pass++;
    else if (r.status === "fail" || r.status === "timeout") out.bad++;
    else out.skip++;
    if (r.children) walkStats(r.children, out);
  }
}

function nodeHtml(r: StepResult, depth: number): string {
  const st = esc(STATUS_ZH[r.status] ?? r.status);
  const label =
    r.kind === "group"
      ? esc(r.label)
      : esc(`${KIND_ZH[r.kind] ?? r.kind}${r.label && r.label !== r.kind ? ` · ${r.label}` : ""}`);
  const detail = r.detail ? `<span class="d"> ${esc(r.detail)}</span>` : "";
  const ms = r.durationMs > 0 ? `<span class="ms">${r.durationMs}ms</span>` : "";
  const row = `<div class="row st-${r.status}"><span class="dot"></span><span class="lb">${label}</span>${detail}${ms}<span class="st">${st}</span></div>`;
  if (r.kind === "group" && r.children && r.children.length > 0) {
    const kids = r.children.map((c) => nodeHtml(c, depth + 1)).join("");
    return `<details open class="grp"><summary>${row}</summary><div class="kids">${kids}</div></details>`;
  }
  return row;
}

/** RunResult → 自包含 HTML 报告字符串 */
export function renderReportHtml(result: RunResult): string {
  const stats: Stats = { pass: 0, bad: 0, skip: 0, truncated: false };
  walkStats(result.steps, stats);
  const dur = Math.max(0, result.finishedAt - result.startedAt);
  const runZh = result.status === "done" ? "完成" : result.status === "aborted" ? "已中止" : "失败";
  const body = result.steps.map((r) => nodeHtml(r, 0)).join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>测试报告 · ${esc(result.suiteName)}</title>
<style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 20px 48px; background: #f6f7f9; color: #1e293b;
  font: 14px/1.55 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
main { max-width: 960px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0;
  border-radius: 8px; padding: 20px 24px 24px; }
h1 { font-size: 18px; margin: 0 0 4px; }
.meta { color: #64748b; font-size: 12.5px; margin-bottom: 14px; }
.badge { display: inline-block; padding: 1px 10px; border-radius: 4px; font-size: 12.5px;
  color: #fff; vertical-align: 2px; margin-left: 8px; }
.badge.ok { background: #16a34a; }
.badge.bad { background: #dc2626; }
.badge.stop { background: #b91c1c; }
.chips { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; }
.chip { border: 1px solid #e2e8f0; border-radius: 6px; padding: 4px 12px; font-size: 12.5px; }
.chip b { font-size: 14px; margin-left: 4px; }
.chip.p b { color: #16a34a; }
.chip.f b { color: #dc2626; }
.chip.s b { color: #94a3b8; }
.tree { border-top: 1px solid #e2e8f0; padding-top: 10px; }
.row { display: flex; align-items: baseline; gap: 8px; padding: 4px 6px;
  border-bottom: 1px solid #f1f5f9; }
.dot { width: 8px; height: 8px; border-radius: 2px; flex: none; align-self: center; }
.st-pass .dot { background: #16a34a; }
.st-fail .dot { background: #dc2626; }
.st-timeout .dot { background: #ea580c; }
.st-skipped .dot { background: #cbd5e1; }
.st-aborted .dot { background: #b91c1c; }
.lb { font-weight: 600; flex: none; }
.d { color: #475569; font-family: Consolas, "Courier New", monospace; font-size: 12.5px;
  overflow-wrap: anywhere; min-width: 0; }
.ms { margin-left: auto; flex: none; color: #94a3b8; font-size: 12px;
  font-variant-numeric: tabular-nums; }
.st { flex: none; font-size: 12px; width: 34px; text-align: right; }
.st-pass .st { color: #16a34a; }
.st-fail .st, .st-aborted .st { color: #dc2626; }
.st-timeout .st { color: #ea580c; }
.st-skipped .st { color: #94a3b8; }
details.grp { padding-left: 0; }
details.grp > summary { list-style: none; cursor: pointer; }
details.grp > summary::-webkit-details-marker { display: none; }
details.grp > summary::before { content: "▸"; color: #94a3b8; margin-right: 2px; }
details.grp[open] > summary::before { content: "▾"; }
details.grp > .kids { padding-left: 20px; border-left: 2px solid #f1f5f9; margin-left: 10px; }
.trunc { color: #b45309; font-size: 12.5px; padding: 6px; }
footer { margin-top: 18px; color: #94a3b8; font-size: 12px; text-align: right; }
@media print { body { background: #fff; padding: 0; } main { border: 0; } }
</style>
</head>
<body>
<main>
<h1>${esc(result.suiteName)}<span class="badge ${result.status === "done" ? "ok" : result.status === "aborted" ? "stop" : "bad"}">${runZh}</span></h1>
<div class="meta">开始 ${esc(new Date(result.startedAt).toLocaleString())} · 耗时 ${(dur / 1000).toFixed(2)}s</div>
<div class="chips">
<span class="chip p">通过<b>${stats.pass}</b></span>
<span class="chip f">失败/超时<b>${stats.bad}</b></span>
<span class="chip s">跳过/中止<b>${stats.skip}</b></span>
</div>
${stats.truncated ? '<div class="trunc">结果节点超过上限，本报告仅含前段结果</div>' : ""}
<div class="tree">
${body || '<div class="row st-skipped"><span class="dot"></span><span class="lb">（无步骤结果）</span></div>'}
</div>
<footer>Uartix+ 测试序列器 · 生成于 ${esc(new Date().toLocaleString())}</footer>
</main>
</body>
</html>`;
}
