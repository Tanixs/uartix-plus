/**
 * P99a-B1：`module` 产物的 realm 封网探针测试（详设 §5.1-4「验收项，不是备注」的可自动化那一半）。
 *
 * 这里能证明的是**引导脚本的逻辑**：同一套 intrinsics 模型下，摘完之后三个取回路径
 * （全局 own property / 全局原型链 / 间接求值）确实都空了。
 * 这里**不能**证明的是浏览器内核里的 Worker 也如此——那条走 `moduleHost.probeModuleCode`，
 * 由插件库启用与 `enable_plugin` 在真机实测（已列进验收项，不靠推断）。
 *
 * 两条用例专门防"探针自己是哑的"：① 把一个名字做成不可删除 ⇒ 必须点名报出来；
 * ② 环境没有 Worker ⇒ `probeModuleCode` 必须判失败，不能"测不了就算通过"。
 */
import { describe, expect, it } from "vitest";
import {
  EGRESS_ALL,
  EGRESS_GLOBALS,
  MOD_ERROR,
  MOD_PROBE,
  lockdownSource,
  moduleWorkerSource,
} from "./moduleLockdown";
import { MAX_MODULE_BYTES, validateArtifactPayload } from "./artifact";
import { moduleArtifactsOf, probeModuleCode } from "./moduleHost";
import { KIND_REQUIRED_CAP, PLUGIN_CAPS, PURE_UI_CAPS, validateManifest } from "./pluginManifest";

const { createContext, runInContext } = (await import("node:" + "vm")) as unknown as {
  createContext: (obj: Record<string, unknown>) => object;
  runInContext: (src: string, ctx: object) => unknown;
};

interface Realm {
  ctx: object;
  /** realm 里 postMessage 收到的全部消息（引导探针 / 桥 / 求值错误） */
  posted: Record<string, unknown>[];
  probe: { ok: boolean; failed: string[] } | null;
}

/**
 * 造一个"像 Worker 的" realm。
 *
 * 细节都是坑：`vm.createContext({})` 返回的沙箱代理**只把用户态属性透出来**，
 * 从外面读 `ctx.globalThis` 拿到的是 undefined，于是"往 ctx 上挂 fetch"会挂到**外层**对象上，
 * 而 `Object.getPrototypeOf(那个对象)` 就是**进程共享的** Object.prototype——
 * 测试会把别的服务器的 `fetch` 一起污染掉（第一版就是这么炸的）。
 * 所以建 realm 与埋"不可删除的 fetch"都在 vm 内用脚本做。
 */
function makeRealm(extraSetup = ""): Realm {
  const ctx = createContext({ __out: [] as Record<string, unknown>[] });
  runInContext(
    [
      "self = globalThis;",
      "self.postMessage = function(m){ globalThis.__out.push(m) };",
      "self.addEventListener = function(){};",
      "self.fetch = function(){ return Promise.reject(new Error('不该被调到')) };",
      "self.XMLHttpRequest = function(){};",
      "self.WebSocket = function(){};",
      "self.EventSource = function(){};",
      "self.importScripts = function(){};",
      "self.Worker = function(){};",
      "self.SharedWorker = function(){};",
      "self.RTCPeerConnection = function(){};",
      "self.navigator = { sendBeacon: function(){ return false }, userAgent: 'vm-realm' };",
      extraSetup,
    ].join("\n"),
    ctx,
  );
  const posted = ((ctx as Record<string, unknown>).__out ?? []) as Record<string, unknown>[];
  const found = posted.find((m) => m.type === MOD_PROBE);
  return {
    ctx,
    posted,
    probe: found ? { ok: !!found.ok, failed: (found.failed as string[]) ?? [] } : null,
  };
}

/** 跑一段文本进 realm，并返回刷新过探针读数的 realm。 */
function evalIn(realm: Realm, src: string): Realm {
  runInContext(src, realm.ctx);
  const posted = ((realm.ctx as Record<string, unknown>).__out ?? []) as Record<string, unknown>[];
  realm.posted = posted;
  const found = posted.find((m) => m.type === MOD_PROBE);
  realm.probe = found ? { ok: !!found.ok, failed: (found.failed as string[]) ?? [] } : null;
  return realm;
}

describe("realm 封网引导脚本", () => {
  it("摘完之后自证通过：own property / 原型链 / 间接求值三条都空", () => {
    const r = evalIn(makeRealm(), lockdownSource("a".repeat(24)));
    expect(r.probe, "引导脚本没有回报探针结果").not.toBeNull();
    expect(r.probe!.failed).toEqual([]);
    expect(r.probe!.ok).toBe(true);
  });

  it("探针不是哑的：把一个名字做成不可删除，三条取回路径都要点名报出来", () => {
    const r = evalIn(
      makeRealm(
        [
          "delete fetch;",
          "Object.defineProperty(Object.getPrototypeOf(globalThis),'fetch',{value:function(){},configurable:false,writable:false});",
        ].join("\n"),
      ),
      lockdownSource("b".repeat(24)),
    );
    expect(r.probe!.ok).toBe(false);
    expect(r.probe!.failed).toContain("fetch");
    expect(r.probe!.failed).toContain("fetch:proto");
    expect(r.probe!.failed).toContain("fetch:eval");
  });

  it("封网名一律来自 EGRESS_ALL（引导脚本与探针不抄第二份清单）", () => {
    const src = lockdownSource("c".repeat(24));
    for (const n of EGRESS_ALL) {
      expect(src, `引导脚本没摘 ${n}`).toContain(`delete self.${n}`);
      expect(src, `引导脚本没自证 ${n}`).toContain(`typeof self.${n}`);
      expect(src, `引导脚本没探间接求值 ${n}`).toContain(`typeof ${n}`);
    }
    // 表本身要覆盖详设 §5.1-1 点名的八项出网构造器
    for (const n of [
      "fetch",
      "XMLHttpRequest",
      "WebSocket",
      "EventSource",
      "importScripts",
      "Worker",
      "SharedWorker",
      "RTCPeerConnection",
    ]) {
      expect(EGRESS_GLOBALS).toContain(n);
    }
  });

  it("非法 nonce 直接抛：这段文本是拼进源码的，不合法标识符就是注入点", () => {
    expect(() => lockdownSource("短")).toThrow(/nonce/);
    expect(() => lockdownSource("a-b;c")).toThrow(/nonce/);
  });

  it("插件代码求值错误如实回报，不静默成「模块没反应」", () => {
    const r = evalIn(makeRealm(), moduleWorkerSource("throw new Error('插件代码炸了')", "d".repeat(24), "user.mod.one"));
    const err = r.posted.find((m) => m.type === MOD_ERROR);
    expect(err, "求值抛错却没回报").toBeTruthy();
    expect(String(err!.err)).toContain("插件代码炸了");
    // 求值炸之前封网已经跑完并回报过——顺序本身就是合同
    expect(r.probe!.ok).toBe(true);
  });

  it("插件拿到的 uartix 只有 info + host(post/rpc)，没有 Tauri、没有出网口", () => {
    const r = evalIn(
      makeRealm(),
      moduleWorkerSource(
        [
          "uartix.host.post({type:'shape',",
          "keys:Object.keys(uartix).sort().join(','),",
          "hostKeys:Object.keys(uartix.host).sort().join(','),",
          "frozen:Object.isFrozen(uartix)&&Object.isFrozen(uartix.host),",
          "net:[typeof fetch,typeof XMLHttpRequest,typeof WebSocket,typeof navigator].join(','),",
          "tauri:[typeof __TAURI__,typeof __TAURI_INTERNALS__,typeof invoke].join(',')});",
        ].join(""),
        "e".repeat(24),
        "user.mod.shape",
      ),
    );
    const shape = r.posted.find((m) => m.type === "shape");
    expect(shape, "插件代码没能调用 uartix.host.post").toBeTruthy();
    expect(shape!.keys).toBe("host,info,tools");
    expect(shape!.hostKeys).toBe("post,rpc");
    expect(shape!.frozen).toBe(true);
    expect(shape!.net).toBe("undefined,undefined,undefined,undefined");
    /**
     * 详设 §5.1 里"worker 作用域没有 __TAURI__"这条原本标着「实施时用探针实测，不靠推断」。
     * vm realm 只能证明"我们没有把它转递进去"；内核级那一半由真机那轮 `probeModuleCode` 补。
     */
    expect(shape!.tauri).toBe("undefined,undefined,undefined");
  });

  it("插件代码里的顶层 var 不落进 worker 全局（求值包在函数里）", () => {
    const r = evalIn(
      makeRealm(),
      moduleWorkerSource(
        "var 泄漏 = 1; uartix.host.post({type:'leak', onGlobal: typeof globalThis['泄漏'], inScope: typeof 泄漏});",
        "f".repeat(24),
        "user.mod.v",
      ),
    );
    const leak = r.posted.find((m) => m.type === "leak");
    expect(leak!.inScope).toBe("number"); // 代码内部当然看得见自己
    expect(leak!.onGlobal).toBe("undefined"); // 但它没落进全局
  });
});

describe("probeModuleCode 的环境门", () => {
  it("node 环境没有 Worker：判失败，绝不「测不了算通过」", async () => {
    const r = await probeModuleCode("var x = 1;", "user.mod.x");
    expect(r.ok).toBe(false);
    expect(r.failed).toContain("no-worker");
  });

  it("空代码 / 超体积上限在起 worker 之前就拒", async () => {
    expect((await probeModuleCode("   ", "user.mod.x")).failed).toEqual(["empty-code"]);
    const r = await probeModuleCode("a".repeat(MAX_MODULE_BYTES + 1), "user.mod.x");
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual(["code-too-large"]);
  });
});

describe("module 产物与包校验", () => {
  const JS = { format: "js", code: "uartix.host.post({type:'ping'})" };

  it("format 判别 js；空码 / 非 js / 含空字节都拒", () => {
    expect(validateArtifactPayload("module", JS).ok).toBe(true);
    expect(validateArtifactPayload("module", { format: "js", code: "  " }).ok).toBe(false);
    expect(validateArtifactPayload("module", { code: "var a=1" }).ok).toBe(false);
    expect(validateArtifactPayload("module", { format: "esm", code: "var a=1" }).ok).toBe(false);
    expect(validateArtifactPayload("module", { format: "js", code: "a\0b" }).ok).toBe(false);
    expect(validateArtifactPayload("module", { format: "js", code: "x".repeat(MAX_MODULE_BYTES + 1) }).ok).toBe(false);
  });

  it("module 需要 logic.run，而 logic.run 不在自动放行集（会跑 JS 的包不得自动启用）", () => {
    expect(KIND_REQUIRED_CAP.module).toBe("logic.run");
    expect(PLUGIN_CAPS).toContain("logic.run");
    expect(PURE_UI_CAPS).not.toContain("logic.run");
    expect(PURE_UI_CAPS).not.toContain("win.control");
  });

  it("声明了 module 却没写 logic.run ⇒ 整包拒；写了才过", () => {
    const pkg = (caps: string[]) => ({
      format: "uartix-plugin",
      schemaVersion: 2,
      id: "user.agent.modprobe",
      version: "0.1.0",
      name: "封网探针包",
      hostApi: "^1.0",
      capabilities: caps,
      contributions: { modules: [{ id: "m1", entry: "m1.json", name: "探针" }] },
      artifacts: { "m1.json": { kind: "module", ...JS } },
    });
    const bad = validateManifest(pkg(["ui.widget"])); // 声明了 module 却没写 logic.run
    expect(bad.ok).toBe(false);
    expect(bad.errors.join()).toContain("logic.run");
    const good = validateManifest(pkg(["logic.run"]));
    expect(good.ok).toBe(true);
    // 桥接文本里的"module 结构错误"也要能被抓到（contributions 键必须匹配 kinds）
    const wrongKey = validateManifest({ ...pkg(["logic.run"]), contributions: { moduls: [{ id: "m1", entry: "m1.json" }] } });
    expect(wrongKey.ok).toBe(false);
  });

  it("moduleArtifactsOf 只看 module 产物并按 entry 稳定排序", () => {
    const list = moduleArtifactsOf({
      artifacts: {
        "b.json": { kind: "module", ...JS },
        "a.json": { kind: "module", ...JS },
        "t.json": { kind: "theme", vars: { "--bg": "#000" } },
      },
    });
    expect(list.map((m) => m.entry)).toEqual(["a.json", "b.json"]);
  });
});
