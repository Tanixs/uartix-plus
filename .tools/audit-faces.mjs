/**
 * P132-I · 审计面表与浮层驱动（**两份账共用**）。
 *
 * 为什么要抽出来：类名普查（`.tools/class-census.mjs`）与对比度基线（`.tools/audit-live.mjs`）
 * 必须跑在**同一批面**上。面表抄两份就是等着漂——漂了的后果不是报错，是"那本账说覆盖到了，
 * 这本说没覆盖到"，而两句都是绿的。P132-C 立的规矩是"判据不写第二份"，这条把它扩到"面表也不写第二份"。
 *
 * 每一面都把状态**写死在 URL 里**（P132-F）：`preset=proto` 钉布局、`rail=…` 钉导轨、
 * `welcome=…` 钉首启卡。不钉的代价是实测撞上的：profile 里留着"接入"面板开着，
 * 于是每一面都多扫 89 个带字节点、多背 2 条命中区，同一份代码在两个 profile 上交出两本账。
 *
 * 浮层**必须靠真事件开**（真按键 / dev `?click=` / 真右键 / 真 hover）：注入一个 DOM 节点出来不算——
 * 注入的浮层没有真实的定位、层叠与 backdrop，量出来的东西用户看不到。
 * `require` 是"开没开出来"的哨兵：没开出来直接抛，而不是静默少测一面（P132-E）。
 */
export const ORIGIN = "http://localhost:1421";
export const VIEWPORT = { w: 1440, h: 900 };

/** 拼 URL 只走这里：三个状态键都只能出现一次（见 `assertNoDupKeys`） */
export const base = (t, { extra = "", rail = "none", welcome = "0" } = {}) =>
  `/?theme=${t}&welcome=${welcome}&preset=proto&rail=${rail}${extra}`;

/**
 * 同一个键写两遍时 `URLSearchParams.get` 只认第一个：`rail=none` 后面再挂一个 `rail=templates`
 * 不会覆盖它，只会让那一面**静默地"导轨没开"**（P132-G 实测踩了一次）。
 */
export function assertNoDupKeys(path, id) {
  const keys = (path.replace(/^[^?]*\?/, "").match(/[^&=?]+=/g) || []).map((k) => k.slice(0, -1));
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dup.length) throw new Error(`${id}：URL 里 ${dup.join(",")} 出现了两次——后写的会被静默忽略，这一面的状态不是你以为的那个`);
}

/** 哨兵问的是"看得见的一张浮层"，不是"DOM 里有没有这个类"：屏外 -9999 的隐藏实例（列树那份）不算开出来 */
export const OPEN_CHECK = (sel) => `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
  return els.some((e) => {
    const s = getComputedStyle(e), r = e.getBoundingClientRect();
    return s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0"
      && r.width > 8 && r.height > 8 && r.left > -100 && r.top > -100;
  });
})()`;

/** 第 n 枚"落得下鼠标"的元素中心；容器类的中心往往是自己的孩子，所以用 contains */
export const CENTER_OF = (sel, n = 0) => `(() => {
  const els = [...document.querySelectorAll(${JSON.stringify(sel)})];
  const el = els[${n}];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
  const hit = document.elementFromPoint(x, y);
  if (!hit || !(hit === el || el.contains(hit))) return null;
  return { x, y };
})()`;

/** 提示泡那一族：DOM 里前两枚 `.help-hint` 在设置整页**身后**（实测 938,326 / 963,713 命中的是
    `set-card`/`set-content`），照 DOM 顺序点第一枚就永远开不出泡——所以逐枚挑"点得到的那一枚" */
export const FIRST_REACHABLE = (sel) => `(() => {
  for (const el of document.querySelectorAll(${JSON.stringify(sel)})) {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    if (document.elementFromPoint(x, y) === el) return { x, y, n: 1 };
  }
  return null;
})()`;

/**
 * 十三面：启动态两面 + 五张浮层 + 三张"点一下才出现"的面（P132-G）+ 首启两张卡与面板空态（P132-H）。
 * `model`/`speclib` 各抓到 2 条；`hovermenu` 是 0 条——它钉的是上一批那个结论：
 * 以后谁把 `.tb-menu-item:hover` 改回 `--accent`，这一面会当场多一条。
 * `?click=` 的值里有空格（`:nth-child` 前那个后代选择器）必须编码，否则 `URLSearchParams`
 * 把空格读成 `+`、`querySelector(".rp-seg+button…")` 直接抛，表现就是"这一面永远开不出来"。
 */
export const SURFACES = [
  { id: "workspace", path: (t) => base(t) },
  { id: "settings", path: (t) => base(t, { extra: "&open=settings/appearance" }) },
  { id: "palette", path: (t) => base(t), drive: "palette", require: ".cmdk" },
  { id: "menu", path: (t) => base(t, { extra: "&click=.cb-ws-btn" }), require: ".cb-ws-menu" },
  { id: "lbx", path: (t) => base(t, { extra: "&click=.baud-toggle", rail: "link" }), require: ".ctx-menu.lbx" },
  { id: "ctxmenu", path: (t) => base(t), drive: "ctxmenu", require: ".ctx-menu" },
  { id: "hint", path: (t) => base(t, { extra: "&open=settings/appearance" }), drive: "hint", require: ".help-bubble" },
  { id: "model", path: (t) => base(t, { extra: "&open=settings/model" }) },
  { id: "speclib", path: (t) => base(t, { extra: `&click=${encodeURIComponent(".rp-seg button:nth-child(2)")}`, rail: "templates" }), require: ".spl-list" },
  { id: "hovermenu", path: (t) => base(t, { extra: "&click=.cb-ws-btn" }), drive: "hovermenu", require: ".cb-ws-menu" },
  { id: "welcome1", path: (t) => base(t, { welcome: "1" }), require: ".wlc-body" },
  { id: "welcome2", path: (t) => base(t, { welcome: "2" }), require: ".wlc-body" },
  { id: "cmdk-empty", path: (t) => base(t), drive: "cmdkEmpty", require: ".cmdk-empty" },
];

/**
 * 会话：把 CDP 的 `send` / 页内 `evaluate` / `rest` / 按键 / 打字注进来，
 * 这样面表与驱动只有一份，而两个脚本各自决定"跑完之后量什么"。
 */
export function makeSession({ send, evaluate, rest, key, typeText, ready = '!!document.querySelector(".titlebar") && !!document.querySelector(".dv-react-tab")' }) {
  async function goto(url) {
    await send("Page.navigate", { url });
    for (let i = 0; i < 60; i++) {
      if (await evaluate(ready)) break;
      await rest(200);
    }
    // 布局没摆完时采到的盒子尺寸是假的；这 1200ms 也是 dev `?click=` 那 1400ms 定时器的一部分等待
    await rest(1200);
  }
  async function waitOpen(sel, ms = 6000) {
    const expr = OPEN_CHECK(sel);
    for (let waited = 0; waited < ms; waited += 200) {
      if (await evaluate(expr)) return true;
      await rest(200);
    }
    return false;
  }
  async function hoverAt(at) {
    // 先从上方移进来：没有"进入"这一步就没有 mouseover/mouseenter，React 的 onMouseEnter 不会跑
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y - 24, button: "none" });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y, button: "none" });
    await rest(450);
  }
  async function drive(how) {
    if (how === "palette") {
      await key("P", "KeyP", 80, 2 | 8);
      await rest(550);
      return;
    }
    if (how === "cmdkEmpty") {
      // 先等面板真开出来再打字：不等的话字符落进工作区，"空态"这一面就成了从没开出来的假面
      await key("P", "KeyP", 80, 2 | 8);
      if (!(await waitOpen(".cmdk"))) throw new Error("cmdkEmpty：命令面板没开出来，空态无从谈起");
      await typeText("qqqzzz");
      await rest(450);
      return;
    }
    if (how === "ctxmenu") {
      const at = await evaluate(CENTER_OF(".ctl-main"));
      if (!at) throw new Error("ctxmenu：.ctl-main 不存在、太小或被盖住，右键点不到——这一面不能空着记账");
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "right", clickCount: 1, buttons: 2 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "right", clickCount: 1, buttons: 0 });
      await rest(450);
      return;
    }
    if (how === "hint") {
      const at = await evaluate(FIRST_REACHABLE(".help-hint"));
      if (!at) throw new Error("hint：没有一枚点得到的 .help-hint（全被盖住了？）——这一面不能空着记账");
      await hoverAt(at);
      return;
    }
    if (how === "hovermenu") {
      // 先等菜单开出来（`?click=` 是挂载后 1400ms 才点的），再把鼠标落到第 2 枚项上
      if (!(await waitOpen(".cb-ws-menu"))) throw new Error("hovermenu：菜单没开出来，悬停档无从谈起");
      const at = await evaluate(CENTER_OF(".tb-menu-item", 1));
      if (!at) throw new Error("hovermenu：第 2 枚 .tb-menu-item 落不下鼠标——这一面不能空着记账");
      await hoverAt(at);
      return;
    }
    throw new Error(`不认识的驱动方式：${how}`);
  }
  return { goto, drive, waitOpen, hoverAt };
}
