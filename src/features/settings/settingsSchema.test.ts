/**
 * P99b-N6 · 设置项自己的完整性守卫（详设 §6 G1/G2/G6 + R1/R2/R4）。
 *
 * 这批为什么从这道守卫开始：`settingsSchema.ts:26` 那句注释写着「全量声明：每个 Settings 键
 * 恰好一条」——**而它现在已经是假的**（33 个 Settings 键、schema 只 31 条，缺的恰好是
 * `marketIndexUrl` / `marketMirrorPrefix`）。原来那道"完整性检查"（`settingsTools.test.ts:22`）
 * 是拿 schema 数它自己，漏登一个键照样绿 ⇒ §8-52 那条"守卫的夹具自己红不了＝没有守卫"的又一次复发。
 */
import { describe, expect, it, vi } from "vitest";

const stubStore = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => stubStore.get(k) ?? null,
  setItem: (k: string, v: string) => void stubStore.set(k, v),
  removeItem: (k: string) => void stubStore.delete(k),
});

const fsSpec = "node:fs";
const urlSpec = "node:url";
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const { readFileSync, readdirSync, statSync } = (await import(fsSpec)) as {
  readFileSync: (p: string, e?: string) => string;
  readdirSync: (p: string, o?: unknown) => { name: string; isDirectory(): boolean }[];
  statSync: (p: string) => { isDirectory(): boolean };
};
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function srcFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(ROOT + dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (statSync(ROOT + p).isDirectory()) srcFiles(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}
const ALL_SRC = srcFiles("features").concat(srcFiles("shell"), srcFiles("panels"), ["App.tsx"]);
const read = (rel: string) => readFileSync(ROOT + rel, "utf8");

const { SETTINGS_SCHEMA, agentWritableKeys, schemaEntry } = await import("./settingsSchema");

describe("P99b-N6 · schema 必须与 Settings 键集合双向相等", () => {
  it("schema 内部自洽：键不重复、每条都有分组与敏感性", () => {
    const keys = SETTINGS_SCHEMA.map((e) => e.key as string);
    expect(new Set(keys).size, `schema 里有重复键：${keys.filter((k, i) => keys.indexOf(k) !== i).join("、")}`).toBe(keys.length);
    for (const e of SETTINGS_SCHEMA) {
      expect(e.group, `${String(e.key)} 没分组`).toBeTruthy();
      expect(e.label, `${String(e.key)} 没名字`).toBeTruthy();
      expect(["safe", "protected", "secret"]).toContain(e.sensitivity);
    }
  });

  it("每个 Settings 键恰好一条 schema（**双向**：漏登与多登都红）", async () => {
    const keys = await settingsKeys();
    const declared = SETTINGS_SCHEMA.map((e) => String(e.key));
    const missing = keys.filter((k) => !declared.includes(k));
    const extra = declared.filter((k) => !keys.includes(k));
    expect(missing, `这些设置项没登记进 schema ⇒ AI 读不到、恢复默认也管不到：${missing.join("、")}`).toEqual([]);
    expect(extra, `schema 里登记了 Settings 没有的键：${extra.join("、")}`).toEqual([]);
  });

  it("注释那句「每个 Settings 键恰好一条」不许变成谎话（键数与 schema 条数当场对齐）", async () => {
    const keys = await settingsKeys();
    expect(SETTINGS_SCHEMA.length, "schema 条数与 Settings 键数不等，但注释仍写着「恰好一条」").toBe(keys.length);
    // 反向半边：**声明那一行上面**的注释得真写着这句。
    // 只 `toContain` 整份文件是不够的——我这条批注里也引用了那句话，删掉正主照样绿（探针 P2 实测过）。
    const src = read("features/settings/settingsSchema.ts");
    const head = src.slice(0, src.indexOf("export const SETTINGS_SCHEMA"));
    expect(head, "schema 上方那句全量声明的注释被删了：守卫的口径没了出处（§8-51）").toContain("每个 Settings 键恰好一条");
  });
});

describe("P99b-N6 · 每个设置项都得有个改它的地方（不许只剩 localStorage）", () => {
  /**
   * 有些键的控件不在设置页，而在它自己的面板里——那是**有地方改**，不是没 UI。
   * 这份名单要带理由：不加理由的白名单就是给下一次偷懒留的门。
   */
  const NOT_IN_SETTINGS_PAGE: Record<string, string> = {
    conWrap: "控制台面板自己那条工具条上有「自动换行」开关（ConsolePanel.tsx）",
  };

  /**
   * 设置页把一部分写入**委托**给了自己的模块（主题卡那条链在 `themePicker.selectTheme` 里 patch）。
   * 这些文件一起算"有地方改"，但每条豁免都要被真引用着——不然就是给下一次偷懒留的门。
   */
  const DELEGATED_WRITERS = ["features/settings/themePicker.ts"];

  /**
   * P102：还有一类——**写入者整个文件都不在设置页里**（市场那两行搬进了市场弹窗的「货架来源」）。
   * 它的"被引用"不能只扫 SettingsModal（那里本来就该没有它），要扫全 src：
   * 不然这条豁免会变成"文件删了名单还留着"的空门。
   */
  const WRITERS_ELSEWHERE = ["features/market/MarketSourceRows.tsx"];

  it("P4c 的另一半：豁免文件里再也写不出设置 ⇒ 豁免该删（这条由 P4b 探针实测为红）", () => {
    for (const f of [...DELEGATED_WRITERS, ...WRITERS_ELSEWHERE]) {
      expect(read(f), `${f} 里已经没有 patch 写入了：这条豁免是个空门，删掉它`).toMatch(/patch\w*\(\s*\{/);
    }
  });

  it("Settings 的每个键：设置页里真有一句写它的 patch，或者在名单里写着它在哪", async () => {
    const modal = read("features/settings/SettingsModal.tsx");
    const writers = [modal, ...[...DELEGATED_WRITERS, ...WRITERS_ELSEWHERE].map((f) => read(f))].join("\n");
    for (const f of DELEGATED_WRITERS) {
      expect(modal, `${f} 已经不被设置页引用了：这条豁免该删掉`).toContain(f.slice(f.lastIndexOf("/") + 1).replace(/\.ts$/, ""));
    }
    for (const f of WRITERS_ELSEWHERE) {
      const name = f.slice(f.lastIndexOf("/") + 1).replace(/\.tsx$/, "");
      expect(
        ALL_SRC.some((s) => s !== f && read(s).includes(name)),
        `${name} 已经不被任何界面引用了：这条豁免是个空门，删掉它`,
      ).toBe(true);
    }
    const keys = await settingsKeys();
    // 判据是**写**不是**读**：只 `value={settings.x}` 而没有 `patch({ x …` 的那行是一盏只能看的灯，
    // 用户改了不落地——那比没有这一行更坏（探针 P4 就是这么被抓出来的）。
    const silent = keys.filter(
      (k) => !(new RegExp(`patch\\w*\\(\\s*\\{[^}]*\\b${k}:`).test(writers) || k in NOT_IN_SETTINGS_PAGE),
    );
    expect(silent, `这些键谁都改不了，只能手改 localStorage：${silent.join("、")}`).toEqual([]);
    for (const [k, why] of Object.entries(NOT_IN_SETTINGS_PAGE)) {
      expect(keys, `名单里的 ${k} 已经不是 Settings 键了，删掉这条`).toContain(k);
      expect(why.length, `${k} 的理由太空`).toBeGreaterThan(10);
    }
  });
});

describe("P99b-N6 · 那两个市场键的档位与来源（R2/R4/R5）", () => {
  it("索引地址与镜像前缀登记为 protected：AI 只读不改", async () => {
    const keys = await settingsKeys();
    for (const k of ["marketIndexUrl", "marketMirrorPrefix"]) {
      expect(keys).toContain(k);
      const e = schemaEntry(k);
      expect(e, `${k} 没进 schema`).toBeTruthy();
      expect(e!.sensitivity, `${k} 的敏感性不对：改它等于给模型一条换货架的通道`).toBe("protected");
      expect(agentWritableKeys().map(String), `${k} 出现在模型可写清单里`).not.toContain(k);
    }
  });

  it("两行的回显只准来自派生层：组件里不许自己判 https，也不许抄域名", () => {
    const rows = read("features/market/MarketSourceRows.tsx");
    expect(rows, "市场那两行根本没接派生层，回显就是手写的").toContain("marketEndpointTalk(");
    expect(rows, "组件里再判一次 https ⇒ 与 applyMirror 各说一套").not.toMatch(/startsWith\("https|\^https:\/\//);
  });

  it("P102：两行搬进市场弹窗了——设置页里不许再留一份，市场里也得有入口打开它", () => {
    expect(
      read("features/settings/SettingsModal.tsx"),
      "搬走变成了抄一份：两处各说一套，改一处漏一处",
    ).not.toContain("marketEndpointTalk(");
    expect(
      read("features/market/MarketDialog.tsx"),
      "两行搬过去了却没有入口能打开它 ⇒ 比原来更糟",
    ).toContain("<MarketSourceRows />");
  });

  it("放行域只有一份：声明只许出现在 marketIndex.ts，别处只准 import 它", () => {
    // 唯一豁免：关于页那颗"项目主页"按钮里的仓库链接（那是一个 URL 按钮，不是一份域名单）。
    // 豁免写成常量放在下面，别让它变成"遇到不方便的钉就删掉钉"的口子。
    const REPO_LINK = "https://github.com/Tanixs/uartix-plus";
    const declared = ALL_SRC.filter((f) => read(f).includes("MARKET_ALLOW_HOSTS ="));
    expect(declared, `域名单声明了 ${declared.length} 份`).toEqual(["features/market/marketIndex.ts"]);
    const copies: string[] = [];
    for (const f of ALL_SRC) {
      if (f === "features/market/marketIndex.ts") continue;
      const s = read(f).split(REPO_LINK).join("");
      if (s.includes("raw.githubusercontent.com")) copies.push(f);
    }
    expect(copies, `这些文件抄了一份放行域（会过期，且与 applyMirror 的判定脱钩）：${copies.join("、")}`).toEqual([]);
  });

  it("镜像判定只有一处实现：applyMirror 必须复用 marketEndpointTalk 的内核", () => {
    const store = read("features/market/marketStore.ts");
    const body = store.slice(store.indexOf("export function applyMirror"), store.indexOf("\n}", store.indexOf("export function applyMirror")));
    expect(body, "applyMirror 又开始自己判 https/域名单了 ⇒ 与设置页那句回显会各说一套").toContain("mirrorEndpointVerdict");
    expect(/startsWith\("https|\/\^https:\/\//.test(body), "同一条件写两遍就是两套判定").toBe(false);
  });
});

/** 运行时拿不到 TS 类型：从 settingsStore 的 `load()` 默认值源码里取出键清单（那就是事实全集） */
async function settingsKeys(): Promise<string[]> {
  const src = read("features/settings/settingsStore.ts");
  const start = src.indexOf("const fallback: Settings = {");
  if (start < 0) throw new Error("settingsStore 里的默认值表锚点变了，这条守卫要跟着改");
  const block = src.slice(start, src.indexOf("\n  };", start));
  return [...block.matchAll(/^ {4}(\w+)\??:/gm)].map((m) => m[1]);
}
