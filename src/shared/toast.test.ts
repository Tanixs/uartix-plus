/**
 * P131-A · 提示条的三条钉。
 *
 * 起因是一个查不出来的"没反应"：`guardLocked()` 在只读锁下会 toast 一句「配置只读」，
 * 而那句话**从来没有被看见过**——`.ai-toast-host` / `.ai-toast` 这对类名在 src 下所有
 * .css 里一条规则都没有（门禁 J 只扫 TSX 的 `className`，看不见 `document.createElement`
 * 之后赋的类名，所以这个洞是静默的）。顺带还有第二份问题：同一对类名由两处各自实现
 * （`ai/extRuntime` 与 `operator/lock`），各记各的 host，同一屏可以挂出两列提示。
 *
 * 于是这里钉三件事：实现只有一份、类名真的有样式、行为本身（上限 / 自动消失 / 无 DOM 不出声）。
 */
import { describe, expect, it, vi } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync, readdirSync, statSync } = (await import(fsSpec)) as unknown as {
  readFileSync: (p: string | URL, enc?: string) => string;
  readdirSync: (p: string) => string[];
  statSync: (p: string) => { isDirectory(): boolean };
};
const { fileURLToPath } = (await import(urlSpec)) as unknown as {
  fileURLToPath: (u: string | URL) => string;
};
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = HERE.replace(/[/\\]shared[/\\]?$/, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const files = walk(SRC);
const CSS = files.filter((f) => f.endsWith(".css")).map((f) => readFileSync(f, "utf8")).join("\n");

describe("P131-A · 提示条", () => {
  it("这对类名在 CSS 里真的有规则（曾经一条都没有，于是「配置只读」永远看不见）", () => {
    expect(CSS, ".ai-toast-host 没有样式：提示条会退回贴在 body 末尾的裸 div").toMatch(/\.ai-toast-host\s*\{/);
    expect(CSS, ".ai-toast 没有样式：同上").toMatch(/\.ai-toast\s*\{/);
    // 整列不吃点击：提示不许挡住用户正要按的那颗「退出只读」
    const host = /\.ai-toast-host\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    expect(host, "宿主层要 pointer-events:none，否则提示条会挡键").toContain("pointer-events: none");
  });

  it("实现只有一份（两处手搓＝同一屏能挂两列提示）", () => {
    const owners = files
      .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes(".test."))
      .filter((f) => readFileSync(f, "utf8").includes('className = "ai-toast-host"'));
    expect(owners.map((f) => f.replace(SRC + "/", "")).sort(), "建 host 的地方必须只有 shared/toast.ts").toEqual([
      "shared/toast.ts",
    ]);
  });

  /**
   * 行为钉。本仓测试环境是 node（没有 jsdom，其它测试也是自己 stub localStorage），
   * 所以这里只搭一个**最小**假 DOM——只实现 toast.ts 真用到的那几件事：
   * createElement / body.appendChild / children / firstElementChild.remove / setTimeout。
   */
  it("同一屏最多 4 条、到点自己消失、没有 DOM 时不出声", async () => {
    type Node = {
      className: string;
      textContent: string;
      children: Node[];
      firstElementChild: Node | null;
      isConnected: boolean;
      remove(): void;
      appendChild(n: Node): void;
    };
    const mk = (): Node => {
      const node: Node = {
        className: "",
        textContent: "",
        children: [],
        firstElementChild: null,
        // toast.ts 靠 isConnected 认"宿主还挂在文档上吗"（被整体清空过就重建）
        isConnected: false,
        remove() {
          /* 由父节点摘走，见下方 appendChild 的联动 */
        },
        appendChild(c: Node) {
          node.children.push(c);
          node.firstElementChild = node.children[0] ?? null;
          c.isConnected = true;
          c.remove = () => {
            node.children = node.children.filter((x) => x !== c);
            node.firstElementChild = node.children[0] ?? null;
            c.isConnected = false;
          };
        },
      };
      return node;
    };
    const body = mk();
    body.isConnected = true;
    const timers: Array<() => void> = [];
    vi.stubGlobal("document", { body, createElement: () => mk() });
    vi.stubGlobal("window", { setTimeout: (fn: () => void) => timers.push(fn) });
    const { toast } = await import("./toast");

    for (let i = 0; i < 6; i++) toast(`第 ${i} 条`);
    const host = body.children[0];
    expect(host?.className, "第一次调用就该建出宿主").toBe("ai-toast-host");
    expect(host.children.length, "同时最多 4 条，超出的最旧一条让位").toBe(4);
    expect(host.children[0].textContent, "留下的应该是最新那 4 条").toBe("第 2 条");
    while (timers.length) timers.shift()!();
    expect(host.children.length, "到点要自己消失，不留在屏上").toBe(0);
    vi.unstubAllGlobals();
  });

  it("没有 DOM（单测/预渲染环境）时静默返回，不抛", async () => {
    vi.stubGlobal("document", undefined);
    const { toast } = await import("./toast");
    expect(() => toast("不该炸")).not.toThrow();
    vi.unstubAllGlobals();
  });
});
