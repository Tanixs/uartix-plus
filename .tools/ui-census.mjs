/**
 * P156-B3 · 控件响应普查（手动跑，不进 check:all：它要点满 14 面的控件）。
 *
 * 为什么要有它：静态门只证明"每个 TSX 类名都有 CSS / 每个 invoke 都注册了"，
 * 证明不了"这一颗按钮点下去真的有人接"。活体审计（audit-live）量的是对比度与命中区，
 * 也不点按钮。于是"死键"（渲染了、看着是控件、点了没反应）没有任何一道门在看。
 *
 * 判据（与详设 §B3 一致）：
 *   - 每个面枚举 button / input / select / textarea / [data-ctl]，**可见**且未禁用；
 *   - 安全动作：点击 / 输入 / 切换；危险动作（连接、发送、删除、导入、清空…）走
 *     关键词白名单**跳过并计数**，绝不点；
 *   - 一次动作后 400ms 内出现 ①DOM 结构变化 ②值/勾选变化 ③浮层新开
 *     ④aria-* 状态翻转 ⑤IPC 尝试（浏览器里 invoke 必抛，抛了也算"有人接"）之一 = 有响应；
 *   - 动作后会**尽量还原**（再点一次开关 / 恢复输入值 / Esc 关浮层），避免污染下一颗；
 *     浮层被 Esc 收掉后**重开再继续**（menu/palette/ctxmenu/hint/hovermenu/lbx/cmdkEmpty）——
 *     不重开的话每张浮层只能测到第一颗；
 *   - 「点前 `.qk-err` 已在显示、点后零变化」单列 `bailout`（横幅幂等盲区，需人工裁决）：
 *     连续点同一类失败命令时，第二次起 setErr 收到同一句话，React 就地收回不重渲——
 *     零变化的成因是"上一颗已经把同一句错误摆在屏幕上"，不是死键（probe-qk5 双打法实测）。
 *
 * 用法（同 audit-live：1421 dev server + 9333 一次性 profile 的 headless Edge）：
 *   npx vite --port 1421 --strictPort
 *   msedge --headless=new --remote-debugging-port=9333 --user-data-dir=<一次性> http://localhost:1421/
 *   node .tools/ui-census.mjs [--only=face1,face2] [--max=60]
 *
 * 输出：.tmp/p156/ui-census.json + 控制台摘要；无响应/报错逐条带身份，供人工裁决。
 */
const CDP_HTTP = "http://127.0.0.1:9333";
const { writeFileSync, mkdirSync } = await import("node:fs");
const { fileURLToPath } = await import("node:url");
const path = await import("node:path");
const { ORIGIN, VIEWPORT, SURFACES, makeSession, CENTER_OF, FIRST_REACHABLE } = await import("./audit-faces.mjs");

const args = process.argv.slice(2);
const only = args.find((a) => a.startsWith("--only="))?.slice(7)?.split(",").filter(Boolean);
const MAX = Number(args.find((a) => a.startsWith("--max="))?.slice(6) ?? "60");

let list = null;
try {
  list = await (await fetch(`${CDP_HTTP}/json`)).json();
} catch {
  list = null;
}
if (!Array.isArray(list)) {
  console.error(`连不上 ${CDP_HTTP}。先起 1421 dev server 与 9333 headless Edge（用法见文件头）`);
  process.exit(1);
}
const page =
  list.find((t) => t.type === "page" && String(t.url).startsWith(ORIGIN)) ??
  list.find((t) => t.type === "page" && !String(t.url).startsWith("edge://") && !String(t.url).startsWith("devtools://"));
if (!page) throw new Error("9333 上没有应用的页（只看到 Edge 内部页）");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});
let seq = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const n = ++seq;
    const timer = setTimeout(() => {
      pending.delete(n);
      rej(new Error(`CDP ${method} 20s 没回包`));
    }, 20_000);
    pending.set(n, (m) => {
      clearTimeout(timer);
      res(m);
    });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const rest = (ms) => new Promise((r) => setTimeout(r, ms));
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  const ex = r.result?.exceptionDetails;
  if (ex) throw new Error(`页内异常：${JSON.stringify(ex).slice(0, 300)}`);
  return r.result?.result?.value;
}
async function key(k, code, vk, modifiers = 0) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
}
async function typeText(s) {
  for (const ch of s) {
    const up = ch.toUpperCase();
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code: "Key" + up, windowsVirtualKeyCode: up.charCodeAt(0), text: ch, unmodifiedText: ch });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code: "Key" + up, windowsVirtualKeyCode: up.charCodeAt(0) });
    await rest(30);
  }
}
const { goto, drive, waitOpen, hoverAt } = makeSession({ send, evaluate, rest, key, typeText });

/**
 * 页内普查内核：一次 evaluate 跑完一颗控件（含 900ms 观察窗）。
 * 返回 { id, result, why }，控件身份在页内拼好（索引 + 类名 + 文本）。
 */
const CENSUS_ONE = (idx) => `(async () => {
  const DANGER = ["连接","断开","发送","删除","清空","导入","导出","应用","停止","录制","回放","更新","重启","退出","卸载","重置","恢复","安装","浏览","上传","下载","启动演示","停止演示","Connect","Disconnect","Send","Delete","Clear","Import","Export","Apply","Stop","Record","Replay","Update","Restart","Quit","Uninstall","Reset","Restore","Install","Browse","Upload","Download"];
  /* 浏览器里点不动的：窗口三键（最小化/最大化/关闭）走 Tauri 窗口 API，本环境必无响应。
     它们是**环境跳过**，不是"无响应"——写报告时单列，别混进死键。 */
  const ENV_SKIP = ["最小化","最大化","关闭","Minimize","Maximize","Close"];
  const root = window.__censusRoot ?? document.body;
  const pluck = [...root.querySelectorAll('button, input, select, textarea, [data-ctl], [role="option"], [role="menuitem"], [role="tab"], .dv-tab')].filter((el) => {
    if (el.closest("[data-census-skip]")) return false;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
    if (el.readOnly) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    /* 「点得到」才算控件：中心点被别的层挡住（设置弹窗盖着底下的 TX 面板）时，
       用户根本点不到它——拿合成事件硬点出来的"零变化"是假死键（终跑前 model 面
       21 条 qk-chip 就是这么误报的）。命中测试与 audit-faces 的 FIRST_REACHABLE 同法。 */
    const x = Math.round(r.x + r.width / 2);
    const y = Math.round(r.y + r.height / 2);
    if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return hit === el || el.contains(hit) || (hit && hit.contains(el));
  });
  /* 枚举序重排：设置页内容区（.set-content）排到导航（.set-nav）前面。
     不重排的话索引先走完 11 颗导航项——每颗都把页签切走，等 Index 走到内容区时
     页签早被切到"关于"了，**被 URL 钉住的那一页一颗都测不到**（深跑实测：
     整个设置面测出的全是弹窗背后的工作区控件）。稳定排序，非设置面零影响。 */
  const ordered = [
    ...pluck.filter((el) => el.closest(".set-content")),
    ...pluck.filter((el) => !el.closest(".set-content")),
  ];
  const el = ordered[${idx}];
  if (!el) return null;
  const label = (el.getAttribute("aria-label") || el.title || el.textContent || "").trim().slice(0, 40);
  const ident = {
    tag: el.tagName.toLowerCase(),
    cls: String(el.className).split(" ").filter(Boolean).slice(0, 2).join("."),
    type: el.getAttribute("type") || "",
    label,
    i: ${idx},
  };
  const dangerHit = DANGER.find((k) => label.includes(k));
  if (dangerHit) return { ident, result: "skip", why: "危险词：" + dangerHit };
  const envHit = ENV_SKIP.find((k) => label.includes(k));
  if (envHit) return { ident, result: "env", why: "窗口控制在浏览器环境无宿主：" + envHit };
  /* 两类判据盲区（首跑实测，属工具边界不是死键）：
     ① dockview 的页签容器：枚举扫到的是容器不是控件，点它的中心本来就不该有反应；
     ② 只有一个选项的 select：切到自己是空动作。 */
  if (el.classList.contains("dv-tabs-and-actions-container")) {
    return { ident, result: "skip", why: "页签容器（非控件）" };
  }
  if (el.tagName === "SELECT" && el.options.length <= 1) {
    return { ident, result: "skip", why: "单选项 select：切换等价（判据盲区）" };
  }
  if (el.classList.contains("dv-tab") && el.classList.contains("dv-active-tab")) {
    return { ident, result: "skip", why: "已激活页签：点击无变化是正常" };
  }
  /* 两类后补盲区（深跑实测）：
     ③ 导轨 sach：它是**拖拽**调整控件，单击本来就不该有反应；
     ④ 控制画布已激活分组页签：单击无变化是正常（双击才进重命名）。 */
  if (el.classList.contains("rail-sash")) {
    return { ident, result: "skip", why: "拖拽调整控件：单击本是空动作（判据盲区，拖拽不在巡查动作集）" };
  }
  if (el.classList.contains("ctl-tab") && el.classList.contains("active")) {
    return { ident, result: "skip", why: "已激活分组页签：单击无变化是正常（双击才重命名）" };
  }

  const width = () => {
    let nodes = 0;
    const obs = new MutationObserver((ms) => { nodes += ms.length; });
    obs.observe(root, { childList: true, subtree: true, attributes: true, characterData: true });
    return { stop: () => { obs.disconnect(); return nodes; } };
  };
  const state = () => JSON.stringify({
    v: el.value ?? null, ck: el.checked ?? null, si: el.selectedIndex ?? null,
    ae: el.getAttribute("aria-expanded"), ap: el.getAttribute("aria-pressed"),
    as: el.getAttribute("aria-selected"), cls: String(el.className),
    overlays: document.querySelectorAll('[role="menu"],[role="listbox"],[role="dialog"],.ctx-menu,.cmdk,.modal-mask,.help-bubble').length,
    active: document.activeElement === el,
  });
  const before = state();
  const errBefore = document.querySelector(".qk-err")?.textContent ?? null;
  const watcher = width();
  let threw = null;
  let ipcTry = false;
  const onRej = (e) => {
    const s = String(e.reason ?? "");
    /* Tauri invoke 在浏览器里的失败形态有**两种**：v2 内部读 __TAURI_INTERNALS__.transformCallback
       抛 TypeError（消息里既没有 "TAURI" 也没有 "IPC"）；插件式调用（如 plugin-opener 的 openUrl）
       是 "Cannot read properties of undefined (reading 'invoke')"。只认前两个关键词会把
       「点了、走了 IPC、环境必挂」误判成死键（qk-chip 首跑 21 条的教训 + 关于页外链 3 条的教训）。 */
    if (s.includes("TAURI") || s.includes("tauri") || s.includes("IPC") || s.includes("transformCallback") || s.includes("invoke")) ipcTry = true;
  };
  window.addEventListener("unhandledrejection", onRej);
  try {
    if (el.tagName === "INPUT" && el.type === "checkbox") {
      el.click();
    } else if (el.tagName === "SELECT") {
      const orig = el.selectedIndex;
      el.selectedIndex = (orig + 1) % Math.max(1, el.options.length);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      el.selectedIndex = orig;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      const orig = el.value;
      const t = el.type;
      const probe = t === "number" || t === "range" ? "7" : t === "color" ? "#123456" : "911";
      setter.call(el, probe);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 80));
      setter.call(el, orig);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      /* 不是表单控件：dockview 页签、菜单项这类吃 pointerdown/mousedown 序列，
         单纯的 el.click() 它们不认（首跑实测全部误报"无响应"）。整套指针序列发一遍。 */
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2, y = r.y + r.height / 2;
      const mk = (type) => new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 });
      el.dispatchEvent(mk("pointerdown"));
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
      el.dispatchEvent(mk("pointerup"));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
    }
    await new Promise((r) => setTimeout(r, 900));
  } catch (e) {
    threw = String(e?.message ?? e).slice(0, 160);
    if (threw.includes("TAURI") || threw.includes("tauri") || threw.includes("transformCallback") || threw.includes("invoke")) ipcTry = true;
  }
  window.removeEventListener("unhandledrejection", onRej);
  const mutations = watcher.stop();
  const after = state();

  // 收拾现场：开关再点回去；Esc 关浮层；输入已还原
  if (el.tagName === "INPUT" && el.type === "checkbox" && before !== after) {
    try { el.click(); } catch {}
  }
  if (after !== before) {
    try { await new Promise((r) => setTimeout(r, 80)); } catch {}
  }
  return { ident, mutations, changed: before !== after, ipcTry, threw, still: el.isConnected, errBefore, result: null };
})()`;

/**
 * settings/model 两面的 `require` 补挂在普查侧（不动 audit-faces：那是两本账共用的面表）：
 * 这两面的钉法是"整页设置弹窗开着"，不给 require 的话 root=body、上一颗的 Esc 又把它关掉——
 * 实测后果是**设置页本身一颗都没被测**（深跑 200 颗全是弹窗背后的工作区控件，
 * `.set-*` 计数为 0）。补上 require + 免 Esc 收拾，root 才落在 `.modal-mask` 里。
 */
const FACE_REQUIRE = { settings: ".set-page", model: ".set-page" };
/** 这两面**不做** Esc 收拾：Esc 会把被钉的整页弹窗一并关掉，下一颗就全落在工作区上 */
const NO_ESC_CLEANUP = new Set(["settings", "model"]);

/** 浮层面把 root 缩到浮层子树，避免点到底下的工作区；重开浮层后要再跑一遍（root 节点换了） */
async function scopeRoot(requireSel) {
  await evaluate(`(() => {
    const sel = ${JSON.stringify(requireSel)};
    const el = sel ? document.querySelector(sel) : null;
    window.__censusRoot = el && el.closest('[role="dialog"], .modal-mask, .ctx-menu, .cmdk, .cb-ws-menu, .help-bubble') || el || document.body;
    return true;
  })()`);
}

/**
 * 浮层被上一颗的 Esc 收掉后重开（只认这七张有驱动法的面）。
 * 不重开的话 `all[idx]` 在收起的浮层里恒为空，每张浮层只能测到第一颗。
 */
async function reopenOverlay(surface) {
  const leftClick = async (at) => {
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "left", clickCount: 1, buttons: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "left", clickCount: 1, buttons: 0 });
  };
  try {
    if (surface.id === "palette") {
      await key("P", "KeyP", 80, 2 | 8);
      await rest(550);
      return true;
    }
    if (surface.id === "cmdkEmpty") {
      await key("P", "KeyP", 80, 2 | 8);
      await rest(350);
      await typeText("qqqzzz");
      await rest(450);
      return true;
    }
    if (surface.id === "ctxmenu") {
      const at = await evaluate(CENTER_OF(".ctl-main"));
      if (!at) return false;
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: at.x, y: at.y, button: "right", clickCount: 1, buttons: 2 });
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: at.x, y: at.y, button: "right", clickCount: 1, buttons: 0 });
      await rest(450);
      return true;
    }
    if (surface.id === "hint") {
      const at = await evaluate(FIRST_REACHABLE(".help-hint"));
      if (!at) return false;
      await hoverAt(at);
      return true;
    }
    if (surface.id === "menu" || surface.id === "hovermenu" || surface.id === "lbx") {
      const sel = surface.id === "lbx" ? ".baud-toggle" : ".cb-ws-btn";
      const at = await evaluate(CENTER_OF(sel));
      if (!at) return false;
      await leftClick(at);
      await rest(550);
      return true;
    }
  } catch {}
  return false;
}

async function censusFace(surface, theme) {
  await goto(`${ORIGIN}${surface.path(theme)}`);
  if (surface.drive) {
    /* 驱动是 flake 源（新 profile 首次编译后 Ctrl+Shift+P 偶尔落空）：失败先 Esc 清场再试一次，
       两次都开不出来才记面失败——绝不能把整轮普查带走（首跑整轮就是这么崩在 cmdk-empty 的）。 */
    try {
      await drive(surface.drive);
    } catch {
      await key("Escape", "Escape", 27);
      await rest(600);
      try {
        await drive(surface.drive);
      } catch (e2) {
        return { surface: surface.id, error: `驱动失败：${String(e2.message).slice(0, 120)}` };
      }
    }
  }
  const requireSel = surface.require ?? FACE_REQUIRE[surface.id] ?? null;
  if (requireSel && !(await waitOpen(requireSel))) {
    return { surface: surface.id, error: `浮层没开出来（${requireSel}）` };
  }
  await scopeRoot(requireSel);
  const total = await evaluate(`document.querySelectorAll("button, input, select, textarea, [data-ctl]").length`);
  const results = [];
  for (let i = 0; i < MAX; i++) {
    let r = null;
    try {
      r = await evaluate(CENSUS_ONE(i));
    } catch (e) {
      results.push({ i, result: "error", why: `evaluate 失败：${String(e.message).slice(0, 120)}` });
      break;
    }
    if (!r && surface.require) {
      // 可能只是浮层被上一颗的 Esc 收掉了：重开一次再试（真到列表尾时重开也救不回来，自然收场）
      if (await reopenOverlay(surface)) {
        await scopeRoot(requireSel);
        r = await evaluate(CENSUS_ONE(i));
      }
    }
    if (!r) break;
    if (r.result === "skip" || r.result === "env") {
      results.push({ ...r.ident, result: r.result, why: r.why });
    } else {
      const responded = r.mutations > 0 || r.changed || r.ipcTry;
      const bailout = !responded && r.errBefore !== null && String(r.ident.cls).split(".").includes("qk-chip");
      results.push({
        ...r.ident,
        /* `still === false`（动作窗内被重挂载）不是"没响应"：菜单项点完菜单就收、
           预设项点完整个布局重建——节点消失正是动作的**后果**。只有当"被换掉 + 零变化"
           同时出现时，这一格的点才真的说明不了问题（点可能落在已废弃的节点上）。 */
        result: responded ? "ok" : r.still === false ? "unstable" : bailout ? "bailout" : "noresp",
        mutations: r.mutations,
        changed: r.changed,
        ipcTry: r.ipcTry,
        threw: r.threw,
        detached: r.still === false || undefined,
        why: r.still === false && !responded ? "动作窗内元素被重挂载且零变化（工具盲区）" : bailout ? "错误横幅幂等（点前 .qk-err 已在显示）：工具盲区，需人工裁决" : undefined,
      });
    }
    // 浮层被上一颗按钮我们点开关了：把它按 Esc 收掉，避免下一颗在遮罩后面
    //（settings/model 免收拾：Esc 会把钉在场上的整页弹窗一并关掉；
    // 只有套在设置页之上的**嵌套**弹窗（.modal-mask 数 ≥2）才值得按一下）
    if (!NO_ESC_CLEANUP.has(surface.id)) {
      await key("Escape", "Escape", 27);
      await rest(120);
    } else {
      const alive = await evaluate(`!!document.querySelector(".set-page")`);
      if (alive) {
        if ((await evaluate(`document.querySelectorAll(".modal-mask").length`)) > 1) {
          await key("Escape", "Escape", 27);
          await rest(120);
        }
      } else {
        /* 本面被试元素关掉了自己（首颗就是「返回工作区」——点它=关设置页，是正确响应但面没了）：
           按同一 URL 重开，继续测剩下的索引。 */
        await goto(`${ORIGIN}${surface.path(theme)}`);
        if (!(await waitOpen(requireSel))) {
          return { surface: surface.id, error: `被关闭后重开失败（${requireSel}）` };
        }
        await scopeRoot(requireSel);
      }
    }
  }
  return { surface: surface.id, total, tested: results.length, results };
}

const themes = await evaluate(`(async () => {
  const m = await import("/src/styles/builtinThemes.ts");
  return [...m.BUILTIN_THEME_IDS];
})()`);
const theme = themes.includes("begonia") ? "begonia" : themes[0];
const pick = only?.length ? SURFACES.filter((s) => only.includes(s.id)) : SURFACES;
if (only?.length && pick.length !== only.length) {
  throw new Error(`--only= 里有不认识的面：${only.filter((x) => !SURFACES.some((s) => s.id === x)).join(",")}`);
}

await send("Emulation.setDeviceMetricsOverride", { width: VIEWPORT.w, height: VIEWPORT.h, deviceScaleFactor: 1, mobile: false });

const faces = [];
for (const s of pick) {
  process.stdout.write(`${s.id} … `);
  let r;
  try {
    r = await censusFace(s, theme);
  } catch (e) {
    // 面内未捕获异常（驱动/重开之外的）：记这一面失败，继续跑剩下的面
    r = { surface: s.id, error: `面崩了：${String(e?.message ?? e).slice(0, 160)}` };
  }
  faces.push(r);
  if (r.error) {
    console.log(`面失败：${r.error}`);
    continue;
  }
  const ok = r.results.filter((x) => x.result === "ok").length;
  const no = r.results.filter((x) => x.result === "noresp");
  const er = r.results.filter((x) => x.result === "error");
  const ba = r.results.filter((x) => x.result === "bailout");
  const sk = r.results.filter((x) => x.result === "skip").length;
  const ev = r.results.filter((x) => x.result === "env").length;
  const un = r.results.filter((x) => x.result === "unstable").length;
  console.log(`控件 ${r.total} 测 ${r.tested}：响应 ${ok} / 无响应 ${no.length} / 报错 ${er.length} / 横幅幂等 ${ba.length} / 跳过 ${sk} / 环境跳过 ${ev} / 不稳定 ${un}`);
  for (const x of [...no, ...er]) {
    console.log(`   ⚠ [${x.result}] ${x.tag}${x.type ? ":" + x.type : ""}.${x.cls} 「${x.label}」${x.why ? " — " + x.why : ""}`);
  }
  for (const x of ba) {
    console.log(`   ⓘ [bailout] ${x.tag}${x.type ? ":" + x.type : ""}.${x.cls} 「${x.label}」 — ${x.why}`);
  }
}

const out = path.resolve(fileURLToPath(new URL("..", import.meta.url)), ".tmp/p156/ui-census.json");
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ generatedAt: new Date().toISOString(), theme, faces }, null, 2)}\n`, { encoding: "utf8" });
const flat = faces.flatMap((f) => (f.results ?? []).map((x) => ({ surface: f.surface, ...x })));
console.log(
  `\n合计：响应 ${flat.filter((x) => x.result === "ok").length} / 无响应 ${flat.filter((x) => x.result === "noresp").length} / 报错 ${flat.filter((x) => x.result === "error").length} / 横幅幂等 ${flat.filter((x) => x.result === "bailout").length} / 跳过 ${flat.filter((x) => x.result === "skip").length} / 环境跳过 ${flat.filter((x) => x.result === "env").length} / 不稳定 ${flat.filter((x) => x.result === "unstable").length}`,
);
console.log(`写入 ${out}`);
ws.close();
process.exit(0);
