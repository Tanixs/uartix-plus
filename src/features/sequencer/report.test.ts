import { describe, expect, it } from "vitest";

/** 报告生成器测试：结构完整、统计正确、内容转义、分组嵌套 */
import { renderReportHtml } from "./report";
import type { RunResult, StepResult } from "./types";

const r = (over: Partial<StepResult> = {}): StepResult => ({
  stepId: "s1",
  kind: "send",
  label: "send",
  status: "pass",
  startedAt: 0,
  durationMs: 10,
  detail: "HEX 01 03",
  ...over,
});

const result = (over: Partial<RunResult> = {}): RunResult => ({
  suiteId: "sq1",
  suiteName: "冒烟序列",
  startedAt: 1_000,
  finishedAt: 3_500,
  status: "done",
  steps: [],
  ...over,
});

describe("renderReportHtml", () => {
  it("空结果也能出完整骨架", () => {
    const html = renderReportHtml(result());
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("冒烟序列");
    expect(html).toContain("（无步骤结果）");
    expect(html).toContain("2.50s");
  });

  it("统计与状态着色正确（含嵌套 group）", () => {
    const html = renderReportHtml(
      result({
        steps: [
          r({ status: "pass" }),
          r({ status: "fail", detail: "断言 ✗" }),
          r({
            kind: "group",
            label: "循环",
            status: "pass",
            attempts: 2,
            children: [r({ status: "timeout" }), r({ status: "skipped" })],
          }),
        ],
      }),
    );
    expect(html).toContain("通过<b>2</b>");
    expect(html).toContain("失败/超时<b>2</b>");
    expect(html).toContain("跳过/中止<b>1</b>");
    expect(html).toContain("<details open");
    expect(html).toContain('class="row st-timeout"');
  });

  it("suite 名与 detail 做 HTML 转义", () => {
    const html = renderReportHtml(
      result({
        suiteName: '<img src=x onerror=alert(1)>',
        steps: [r({ detail: "<script>alert(2)</script>" })],
      }),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>alert(2)");
    expect(html).toContain("&lt;script&gt;");
  });

  it("截断占位与失败/中止徽标", () => {
    const trunc = renderReportHtml(
      result({ status: "failed", steps: [r({ stepId: "_truncated", status: "skipped", label: "结果截断" })] }),
    );
    expect(trunc).toContain("结果节点超过上限");
    expect(trunc).toContain('badge bad');
    const stop = renderReportHtml(result({ status: "aborted" }));
    expect(stop).toContain("badge stop");
  });
});
