/**
 * P143 · 底层两件事的牙齿：签名槽的缺省必须中性，宿主词汇必须闭合。
 *
 * 为什么这批断言必须自建：**属性选择器对所有静态门禁是隐形的**——
 * 死规则门只提取 `\.类名`（check-dead-classes.cjs:65），门 J3 同样只看类名（check-style.cjs:716）。
 * 也就是说 `[data-ctl="tab"]` 写了而宿主没人挂，没有任何一道门会红，
 * 而那正是本仓最恨的"安静地不生效"（§8-37② 那一族）。缺省漂移同理：
 * `--ctl-press` 从 `none` 被改成 `scale(0.97)`，肉眼看不出来、审计也量不到（它不是对比度问题），
 * 但 8 枚没填槽的主题会一起开始动。所以这两件事只能在这里钉。
 */
import { describe, expect, it } from "vitest";
import { CTL_HOOKS, ELEV_TIERS } from "./hostHooks";
import { specificityOf } from "./renderAudit";
import { APPEARANCE_TOKENS } from "./themeCore";
import { DOCK_HOOK_MAP } from "../shell/dockHostHooks";

/** 本仓的 tsconfig 只挂 DOM/lib，没有 @types/node——沿 p115Audit 那套写法取 node 运行时 */
const fsSpec = "node:fs";
const urlSpec = "node:url";
const pathSpec = "node:path";
const { readFileSync, readdirSync, statSync } = (await import(fsSpec)) as {
  readFileSync: (p: string, e?: string) => string;
  readdirSync: (p: string) => string[];
  statSync: (p: string) => { isDirectory(): boolean };
};
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const { join } = (await import(pathSpec)) as { join: (...p: string[]) => string };

const ROOT = join(fileURLToPath(new URL("./", import.meta.url)), "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
/** 注释里出现的类名 / `!important` 字样不是"用了"，判据必须只看规则体 */
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
const baseCss = read("src/styles/theme.css");
const styleDir = join(ROOT, "src", "styles", "builtinStyles");
const stylePkg = readdirSync(styleDir).filter((f: string) => f.endsWith(".css"));

/** src 下所有 .ts/.tsx（测试文件除外：测试里的字符串不是"宿主写入点"） */
function hostSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\./.test(name)) out.push(p);
    }
  };
  walk(join(ROOT, "src"));
  return out;
}
const HOST = hostSources().map((p) => readFileSync(p, "utf8"));
const hostHas = (re: RegExp) => HOST.some((s) => re.test(s));

/** 从 theme.css 里把总线那串选择器抠出来：与覆盖率脚本的 BUS 常量对账、也用于定位规则体。
 *  按内容认不按行号认——样式表里插一段注释就把行号判据变成假通过。 */
const busMatch = /:where\((button, \[role="button"\][^)]*)\)/.exec(baseCss);
const busSelector = () => {
  if (!busMatch) throw new Error("theme.css 里找不到签名总线那条 :where(...)，整批判据失去对象");
  return busMatch[1];
};

describe("P143 宿主词汇：data-ctl / data-elev 必须双向闭合", () => {
  const css = [baseCss, ...stylePkg.map((f) => read(`src/styles/builtinStyles/${f}`))].join("\n");

  it("CSS 里出现的每个 data-ctl 值都在词表里（写错一个字就是一条永远不生效的规则）", () => {
    const used = [...css.matchAll(/\[data-ctl="([^"]+)"\]/g)].map((m) => m[1]);
    expect(used.length, "反空断言：一份 CSS 都没扫到，这条判据没在跑").toBeGreaterThan(0);
    for (const v of new Set(used)) {
      expect(CTL_HOOKS, `CSS 用了 data-ctl="${v}"，但 hostHooks 的词表里没有这一枚`).toContain(v);
    }
  });

  it("宿主挂出去的每个 data-ctl 值都在词表里（JSX 里打错一个字母，就是一条安静的死钩子）", () => {
    const written = new Set<string>();
    for (const s of HOST) for (const m of s.matchAll(/data-ctl="([^"]+)"/g)) written.add(m[1]);
    expect(written.size, "反空断言：src 里一个 data-ctl 写入点都没扫到").toBeGreaterThan(3);
    for (const v of written) expect(CTL_HOOKS, `宿主写了 data-ctl="${v}"，词表里没有这一枚`).toContain(v);
  });

  it("词表里每一枚都有宿主写入点（表里留着一枚没人挂的角色＝下一位照着 CSS 写规则去等空气）", () => {
    for (const v of CTL_HOOKS) {
      const written = hostHas(new RegExp(`data-ctl="${v}"`)) || hostHas(new RegExp(`"data-ctl",\\s*"${v}"`))
        ? true
        : DOCK_HOOK_MAP.some((m) => m.ctl === v);
      expect(written, `data-ctl="${v}" 在词表里，但 src 下没有任何一处挂它，翻译表里也没有`).toBe(true);
    }
  });

  it("data-elev 只许用 P136 那族已有的档位（不许另起第二套深度词汇）", () => {
    const tiers = [...css.matchAll(/\[data-elev="([^"]+)"\]/g)].map((m) => m[1]);
    expect(tiers.length, "反空断言：一份 CSS 都没扫到档位消费者").toBeGreaterThan(0);
    const allowed = ELEV_TIERS.map(String);
    for (const t of new Set(tiers)) expect(allowed, `档位 ${t} 不存在`).toContain(t);
    const written = HOST.filter((s) => /data-elev/.test(s)).length;
    expect(written, "宿主一处都没挂 data-elev：那主题层就没有可依赖的浮层档").toBeGreaterThan(0);
  });

  it("第三方类名只活在翻译表里（样式表再写 .dv-* 就是下一次升级的雷）", () => {
    for (const f of stylePkg) {
      const body = stripComments(read(`src/styles/builtinStyles/${f}`));
      expect(body, `${f} 的规则体里出现了 .dv-* 第三方类名`).not.toMatch(/\.dv-[a-z]/);
    }
    for (const m of DOCK_HOOK_MAP) expect(m.source, "翻译表的源必须是第三方类名").toMatch(/^\.dv-/);
  });

  /**
   * 这条是本批最值钱的一条断言：翻译表的源类名**在装好的 dockview 样式表里还在吗**。
   * 升级改了名 ⇒ 这里红，代价是"改一行翻译表"；没人查 ⇒ 代价是"用户的流利蓝静默少一页签样式"
   * （§8-58 那次三面同死走的正是后面这条路）。
   */
  it("翻译表里每个第三方类名，装好的 dockview 仍然在用它", () => {
    const dockCss = read("node_modules/dockview-react/dist/styles/dockview.css");
    expect(dockCss.length, "读不到 dockview 的样式表，这条判据就是空转").toBeGreaterThan(1000);
    for (const { source } of DOCK_HOOK_MAP) {
      expect(dockCss, `dockview 的样式表里没有 ${source}：翻译表这一行要跟着它改名，否则钩子挂不上`).toContain(source);
    }
  });
});

describe("P143 签名槽：缺省必须等于 P103 今天的值", () => {
  /**
   * 这张表是"另外 8 枚主题零变化"的全部依据，所以每条都抄自改动前那行 CSS 的字面值。
   * 谁把缺省改成非中性，这一条当场红——改的人必须同时解释那 8 枚为什么会变。
   */
  const DEFAULTS: Record<string, string> = {
    "--ctl-fill-hover": "var(--raise-1)",
    "--ctl-fill-active": "var(--raise-2)",
    "--ctl-fill-selected": "var(--accent-soft)",
    "--ctl-fill-primary-hover": "color-mix(in srgb, var(--accent) 88%, var(--text) 12%)",
    "--ctl-fill-primary-active": "color-mix(in srgb, var(--accent) 78%, var(--text) 22%)",
    "--ctl-line-hover": "var(--line-strong)",
    "--ctl-ring": "var(--ring)",
    "--ctl-ring-w": "2px",
    // 位移与新加的焦点覆盖：缺省 none = 与"这条规则不存在"在渲染上等价
    "--ctl-press": "none",
    "--ctl-press-tight": "none",
    "--ctl-lift": "none",
    "--ctl-focus-outline": "none",
  };

  /** theme.css 里 `:root {` 有十几块（基线 / light / dark / elevation / 签名槽…），
   *  这里要的是**签名槽那一块**：按内容认，不按顺序认——按顺序认的话，谁在上面插一块，
   *  这条就悄悄开始检查别人的块，检查的还是"看不见的东西"，那是最阴的一种假通过。 */
  const slotBlock = () => {
    const blocks = [...baseCss.matchAll(/:root\s*\{([\s\S]*?)\}/g)].map((m) => m[1]);
    const hit = blocks.find((b) => b.includes("--ctl-fill-hover"));
    if (!hit) throw new Error("theme.css 里找不到签名槽那整块 :root（被拆开或改名了？这条判据跟着失效）");
    return hit;
  };

  it("每个有缺省的槽都声明了，且值逐字等于今天的行为", () => {
    const found = new Map([...slotBlock().matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
    for (const [k, v] of Object.entries(DEFAULTS)) {
      expect(found.get(k), `theme.css 的 :root 里 ${k} 不见了或值不是缺省（${found.get(k)}）`).toBe(v);
    }
  });

  it("ring-offset 与输入框焦点三档**故意不在 :root 定义**：不定义，各基元自己的 var() 缺省才生效", () => {
    // 按"声明"判，不按"出现"判：那一块里有一段**注释**在解释为什么不定义，
    // 用 includes() 会被自己的注释判红（这已经是本仓第二次踩同一处了）。
    const declared = new Set([...slotBlock().matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
    for (const k of ["--ctl-ring-offset", "--ctl-input-focus", "--ctl-focus-border", "--ctl-focus-halo"]) {
      expect(declared.has(k), `${k} 一旦在 :root 定义，.btn 的 +1px 与 .seg 的 -2px 就被统一掉了（那是行为变更）`).toBe(false);
    }
  });

  it("总线那份选择器与覆盖率脚本里的 BUS 逐字一致（改了样式没改脚本，读数就是假的）", () => {
    const tool = read(".tools/ctl-coverage.mjs");
    const bus = /const BUS =\s*\n?\s*'([^']+)'/.exec(tool)?.[1] ?? /const BUS = "([^"]+)"/.exec(tool)?.[1];
    expect(bus, "覆盖率脚本里找不到 BUS 常量").toBeTruthy();
    expect(baseCss, `theme.css 里没有这条总线选择器：${bus}`).toContain(`:where(${bus})`);
    // 两边必须是同一串：脚本量的是"总线够不够得着"，样式表漂了读数就自欺
    expect(busSelector()).toBe(bus);
  });

  it("签名槽不许写在主题 token 文件里（那里落成 inline style，降级基线就再也关不掉它）", () => {
    /**
     * `themes/<id>.css` 的键经 parseThemeBlock → rootVars 以 `setProperty` 落到 `<html>` 的
     * **行内样式**（rootVars.ts:87-92），行内压过一切样式表 ⇒ 谁把 `--ctl-press` 写在那儿，
     * `html.no-motion` 与 prefers-reduced-motion 两条清零就全部失效，而且失效得毫无声响。
     * 所以"槽属于组件层"不是偏好，是这条降级链的唯一写法。判据只看声明，不看散文。
     */
    const dir = join(ROOT, "src", "styles", "themes");
    const files = readdirSync(dir).filter((f: string) => f.endsWith(".css"));
    expect(files.length, "反空断言：一枚内置主题都没扫到").toBeGreaterThan(0);
    for (const f of files) {
      const body = stripComments(read(`src/styles/themes/${f}`));
      const hit = body.match(/--ctl-[\w-]+\s*:/);
      expect(hit, `${f} 里声明了签名槽 ${hit?.[0]}：那一层会落成 inline style，压过降级基线`).toBeNull();
    }
  });

  it("总线选中了元素，还得真的读槽（只写选择器不写声明，就是一条安静的美化建议）", () => {
    const bus = busSelector();
    /** 按"声明"定位规则，再把它的选择器整段拿回来判——按行号或按伪类顺序找，样式表加一行就漂 */
    const ruleAround = (decl: string) => {
      const at = baseCss.indexOf(decl);
      expect(at, `theme.css 里找不到声明 ${decl}`).toBeGreaterThan(-1);
      const open = baseCss.lastIndexOf("{", at);
      const start = baseCss.lastIndexOf("}", open) + 1;
      return baseCss.slice(start, baseCss.indexOf("}", at)).replace(/\s+/g, " ");
    };
    const hover = ruleAround("transform: var(--ctl-lift);");
    const active = ruleAround("transform: var(--ctl-press);");
    const focus = ruleAround("outline: var(--ctl-focus-outline);");
    expect(hover, "hover 那条没挂上总线").toContain(`:where(${bus})`);
    expect(hover).toContain(":hover");
    expect(active, "active 没读 --ctl-press：按压这条线断了").toContain(":active");
    expect(focus, "焦点没读 --ctl-focus-outline：环这条线断了").toContain(":focus-visible");
    expect(focus, "环没有留白：依据点名的 ring-offset 就落不了地").toContain("var(--ctl-ring-offset");
    /**
     * 被拖的东西必须在**位移**那两条里排除掉（分隔条 4px 宽，按下去缩 3% 就是把把手
     * 从指头底下挪走），但**不能**从焦点那条里排除——导轨分隔条 tabIndex=0，
     * 键盘也能调宽，它同样需要看得见自己在哪。
     */
    const DRAG = ':where(:not([data-ctl="sash"], [role="separator"], [data-pdrag]))';
    expect(hover, "hover 位移没排除拖拽件").toContain(DRAG);
    expect(active, "active 位移没排除拖拽件").toContain(DRAG);
    expect(focus, "焦点环那条不该把拖拽件也排除掉（分隔条是键盘可达的）").not.toContain(DRAG);
    // 排除段必须在第二个 :where() 里：写成裸 :not() 会把特异度从 0 抬到 (0,1,0)，反过来压过领域面板
    expect(hover, "排除段没用 :where() 包住，总线不再是零特异度").toContain(`):where(:not(`);
    // 小控件那一档读另一个槽，否则 0.97 与 0.94 分不开（D1 裁的两档）
    const tight = baseCss.slice(baseCss.indexOf(':where(.icon-btn, [data-ctl="tool"]'));
    expect(tight.slice(0, 260), "tight 那条没读 --ctl-press-tight").toContain("var(--ctl-press-tight)");
    // 浮层档的消费面：挂了 data-elev 却没人为它落地，主题就无从接手
    expect(baseCss, '[data-elev="4"] 没有被任何基元消费').toMatch(/\[data-elev="4"\]\s*\{[^}]*var\(--elevation-4\)/);
  });

  it("`--ctl-*` 与 `--elevation-*` 都不进 AI 外观白名单（模型能改手感就等于绕过了主题这一层）", () => {
    // 例外只有一个：`--ctl-h-*` 是控件**高度**，那是密度旋钮、不是签名，P91 起就在白名单里。
    const signature = /^--ctl-(?!h-)/;
    for (const t of APPEARANCE_TOKENS) {
      expect(signature.test(t), `${t} 出现在白名单里：签名属于主题，不属于一次 tool call`).toBe(false);
      expect(t.startsWith("--elevation-"), `${t} 出现在白名单里`).toBe(false);
    }
    // 反空断言：这些槽确实存在，否则上面那个循环是在跟空气较劲
    const declared = [...slotBlock().matchAll(/(--ctl-[\w-]+)/g)].map((m) => m[1]);
    expect(declared.filter((k) => signature.test(k)).length).toBeGreaterThanOrEqual(8);
  });
});

describe("P143 降级义务：填了位移槽就得给清零，而且不加 !important", () => {
  for (const f of stylePkg) {
    const raw = read(`src/styles/builtinStyles/${f}`);
    const css = stripComments(raw);
    const prefix = f.replace(/\.css$/, "");
    // 只数规则体里的声明：注释里那些"`--ctl-press` 要清零"不是填槽，数进来就是把判据挂在散文上
    const slots = [...css.matchAll(/(--ctl-(?:press|press-tight|lift))\s*:\s*([^;]+);/g)].filter(
      (m) => m[2].trim() !== "none",
    );
    it(`${f}${slots.length ? "（设了位移槽 ⇒ 必须自己降级）" : "（没设位移槽 ⇒ 无义务）"}`, () => {
      if (!slots.length) return; // 没填位移就不欠这条；填了才欠（下面整段就是那笔账）
      expect(css, "缺系统偏好那条").toContain("@media (prefers-reduced-motion: reduce)");
      expect(css, "缺设置页那条（html.no-motion 的等价写法）").toContain(`[data-theme="${prefix}"].no-motion`);
      /**
       * 清零必须**真的压得住**填值那一处，而压法不许是 `!important`（B 门天花板只许降）。
       * 层叠只认两条：特异度更高，或同特异度且写在后面。这里按这两条判——
       * 写成 `:root[…].no-motion`（更高特异度）会被净化器判成 global_selector：
       * 内置包与插件包同一台机器判（builtinStyles.test.ts:50 vs artifact.ts:183），内置没有理由更宽。
       */
      const spec = (s: [number, number, number]) => s[0] * 10_000 + s[1] * 100 + s[2];
      const degrade = spec(specificityOf(`[data-theme="${prefix}"].no-motion`));
      const fill = spec(specificityOf(`:root[data-theme="${prefix}"]`));
      const fillAt = css.search(/--ctl-press\s*:/);
      const degradeAt = css.indexOf(`[data-theme="${prefix}"].no-motion`);
      const mediaAt = css.indexOf("@media (prefers-reduced-motion: reduce)");
      expect(degrade >= fill && degradeAt > fillAt, "设置页那条压不住填值那条").toBe(true);
      expect(mediaAt > fillAt, "系统偏好那条写在填值之前就没压得住（同特异度靠后写者胜）").toBe(true);
      expect(css.match(/!important/g) ?? [], "内置 style 包一条 !important 都不该需要").toEqual([]);
      expect(slots.length, "反空断言：这条判据没扫到任何位移槽").toBeGreaterThan(0);
    });
  }
});

/**
 * P146-B：用户在流利蓝里看到"很多按钮像图片粘贴，四角有不圆润的阴影"。
 * 原因是宿主把工具栏/面板工具条幽灵化（底色与描边写 transparent）时**没关投影**，
 * 而主题给 `.btn`/`.icon-btn` 的 box-shadow 特异性更低——它赢得了底色，赢不到没人声明的属性，
 * 于是屏幕上只剩一只只看不见的盒子在投影。
 * 这条不变式写成一句：**脸和影是一对，声明"没有脸"的规则负责把影一起关掉**。
 */
describe("P146-B 不变式：没有脸就没有影", () => {
  /** 按花括号切规则（不按行）：@media 里的规则体本身是干净的 `选择器 { 声明 }`。 */
  const rulesOf = (css: string) => {
    const src = stripComments(css);
    const out: { sel: string; body: string }[] = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const head = m[1].trim().replace(/\s+/g, " ");
      if (head.startsWith("@")) continue; // @font-face / @keyframes 这类块头不是选择器
      out.push({ sel: head, body: m[2] });
    }
    return out;
  };
  /** 只认 `.btn` / `.icon-btn` 这两个**词**：`.mkt-favbtn` 这种同尾名字不算。 */
  const CONTROL = /(?:^|[\s>+~,(])\.(?:btn|icon-btn)(?![\w-])/;
  const GHOST = /background(?:-color)?\s*:\s*transparent/;

  const ghosts = rulesOf(baseCss).filter((r) => CONTROL.test(r.sel) && GHOST.test(r.body));

  it("每条把控件底色抹平的规则，都同时声明了 box-shadow: none", () => {
    const offenders = ghosts.filter((r) => !/box-shadow\s*:\s*none/.test(r.body)).map((r) => r.sel);
    expect(offenders, `这些规则说"没有脸"却没关投影，主题的阴影会从旁边漏出来：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("反空断言：判据确实扫到了幽灵规则（扫不到等于它已经不跑了）", () => {
    expect(ghosts.length, "宿主里「把 .btn/.icon-btn 底色写 transparent」的规则数").toBeGreaterThanOrEqual(3);
  });
});
