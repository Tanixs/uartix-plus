/**
 * P99a-B1：插件 `module` 产物的 **realm 封网引导脚本**（详设 §5.1）。
 *
 * 为什么是一段字符串而不是一个 TS 函数：这段代码必须是新 Worker 里**先于插件代码**求值的东西。
 * 用 `importScripts()` 或额外文件加载会引入一次网络往返和一层 URL 拼接，而那正是要防的东西；
 * 把"我们自己的"代码内联进 worker 源，是唯一能保证顺序又不新开通道做法。
 * 代价是这里没有类型检查 ⇒ 用断言测试补（`moduleLockdown.test.ts` 在真 realm 里跑这段文本）。
 *
 * 为什么可以整段摘了再求值：Dedicated Worker 有**自己的一套 intrinsics**，这里的 `delete`
 * 只作用于 worker 自己的 realm，主文档与宿主页面完全不受影响。
 *
 * ⚠ 如实认知（不给自己贴金）：这是 **realm 内加固，弱于引擎 CSP**。我们主文档根本没有 CSP
 * （`tauri.conf.json` 的 `csp: null`），iframe 那条 `connect-src 'none'` 是引擎级掐网，
 * worker 这条拿不到，所以才需要这段代码。一个足够执着的第三方作者仍有理论逃逸面；
 * 我们的**第一层**边界始终是"安装/启用前人工批准"，这一层是第二道。
 * 彻底解法（主文档 CSP）在详设 §12-2 单独排队，不在这里偷偷宣称已经解决。
 */

/**
 * 要摘掉的出网原语。这张表是**唯一来源**：worker 里摘的、摘完自证的、单元测试逐个尝试的，
 * 全读它（§8-36①——探针清单和被测对象各抄一份，早晚有一份说谎）。
 */
export const EGRESS_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "EventSource",
  "importScripts",
  "Worker",
  "SharedWorker",
  "RTCPeerConnection",
] as const;

/**
 * 整体摘掉的对象型全局。`navigator` 单列是因为 `sendBeacon` 挂在 `WorkerNavigator.prototype`
 * 上而不是全局 own property——删掉 `self.navigator` 这个绑定，比去补别人家的原型可靠，
 * 顺手也把 UA 指纹关了。
 */
export const EGRESS_OBJECT_GLOBALS = ["navigator"] as const;

/** 封网要覆盖的全部名字（引导脚本与测试共用）。 */
export const EGRESS_ALL: readonly string[] = [...EGRESS_GLOBALS, ...EGRESS_OBJECT_GLOBALS];

/** worker → 宿主的引导期消息。探针通过之前，宿主只受理这三条。 */
export const MOD_PROBE = "aiw:mod-probe";
export const MOD_ERROR = "aiw:mod-error";
export const MOD_READY = "aiw:mod-ready";

export const MOD_PRE_PROBE_ALLOWED: readonly string[] = [MOD_PROBE, MOD_ERROR, MOD_READY];

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NONCE_RE = /^[A-Za-z0-9_-]{8,64}$/;

export interface ModuleProbe {
  ok: boolean;
  /** 仍然取得到出网原语的名字（`xxx:proto` / `xxx:eval` 表示从取回路径漏出来的） */
  failed: string[];
}

function guardNames(names: readonly string[]): void {
  for (const n of names) {
    // 这段文本是拼进 worker 源码的：不合法标识符就是注入点，宁可抛错也不拼
    if (!IDENT.test(n)) throw new Error(`封网名不是合法标识符：${n}`);
  }
}

/**
 * 引导脚本（不含插件代码）：封网 → 自证 → 上报。
 *
 * 三条缝都要堵：① 全局 own property（`self.fetch`）、② 全局对象原型链
 * （`Object.getPrototypeOf(self).fetch`）、③ 间接求值（`(0,eval)("typeof fetch")`——同 realm
 * 求值，所以它读到的正是我们清掉的那个槽位，能读到就说明前两条没堵干净）。
 */
export function lockdownSource(nonce: string): string {
  if (!NONCE_RE.test(nonce)) throw new Error(`nonce 不合法（拒绝拼进 worker 源）：${nonce}`);
  guardNames(EGRESS_ALL);
  const lines: string[] = [
    '"use strict";',
    "(function(){",
    `var __NONCE=${JSON.stringify(nonce)};`,
    "var __bad=[];",
    "var __gp=self;",
    "try{__gp=Object.getPrototypeOf(self)||self}catch(e){}",
  ];
  for (const n of EGRESS_ALL) {
    lines.push(`try{delete self.${n}}catch(e){}`);
    lines.push(`try{delete __gp.${n}}catch(e){}`);
  }
  for (const n of EGRESS_ALL) {
    lines.push(`if(typeof self.${n}!=="undefined"){__bad[__bad.length]=${JSON.stringify(n)}}`);
    lines.push(`if(typeof __gp.${n}!=="undefined"){__bad[__bad.length]=${JSON.stringify(`${n}:proto`)}}`);
  }
  lines.push("var __ind=null;try{__ind=(0,eval)}catch(e){}");
  lines.push("if(__ind){");
  for (const n of EGRESS_ALL) {
    lines.push(
      `try{if(__ind("typeof ${n}")!=="undefined"){__bad[__bad.length]=${JSON.stringify(`${n}:eval`)}}}catch(e){}`,
    );
  }
  lines.push("}");
  lines.push(`try{self.postMessage({type:${JSON.stringify(MOD_PROBE)},n:__NONCE,ok:__bad.length===0,failed:__bad})}catch(e){}`);
  lines.push("})();");
  return lines.join("\n");
}

/**
 * 完整 worker 源 = 封网 → 桥 → 插件代码。
 *
 * 插件代码包在函数里求值：它的顶层 `var` 不落进 worker 全局，语法/求值错误经
 * `aiw:mod-error` 如实上报，不静默成"这个模块没反应"。
 *
 * `uartix` 是插件唯一能碰到宿主的门：`host.post/rpc`（有门的通道）、`tools.register/unregister`
 * （B2 的注册面）。**没有 fetch、没有 invoke**——出网与特权都只能经宿主侧那条有裁决的路。
 */
export function moduleWorkerSource(code: string, nonce: string, pkgId: string): string {
  const bridge = [
    "(function(){",
    `var __NONCE=${JSON.stringify(nonce)};`,
    "var __seq=0;",
    "var __pending={};",
    "var __handlers={};",
    "function __post(m){m.n=__NONCE;try{self.postMessage(m)}catch(e){}}",
    "function registerTool(def){",
    "  if(!def||typeof def.name!=='string'||typeof def.handler!=='function')return;",
    "  __handlers[def.name]=def.handler;",
    "  __post({type:'aiw:tool-def',tools:[{name:def.name,",
    "    description:String(def.description||'').slice(0,600),",
    "    parameters:def.parameters||{type:'object',properties:{},additionalProperties:false}}]});",
    "}",
    "function unregisterTool(names){",
    "  var arr=[].concat(names||[]);",
    "  for(var i=0;i<arr.length;i++)delete __handlers[arr[i]];",
    "  __post({type:'aiw:tool-undef',names:arr});",
    "}",
    "function ack(callId,ok,data,err){__post({type:'aiw:tool-ack',callId:callId,ok:ok,data:data,err:err})}",
    "var uartix=Object.freeze({",
    `  info:Object.freeze({pkgId:${JSON.stringify(pkgId)}}),`,
    "  host:Object.freeze({",
    "    post:function(m){if(m&&typeof m==='object')__post(m)},",
    "    rpc:function(m){return new Promise(function(res,rej){",
    "      if(!m||typeof m!=='object')return rej('参数必须是对象');",
    "      var id='q'+(++__seq);m.reqId=id;__pending[id]={res:res,rej:rej};__post(m);",
    "    })}",
    "  }),",
    "  tools:Object.freeze({register:registerTool,unregister:unregisterTool})",
    "});",
    "self.addEventListener('message',function(e){",
    "  var d=e.data;if(!d||typeof d.type!=='string')return;",
    "  if(d.n!==__NONCE)return;",
    "  if(d.type==='aiw:mod-call'){",
    "    var h=__handlers[d.tool];",
    "    if(!h){ack(d.callId,false,null,'模块里没有这支工具：'+String(d.tool).slice(0,60));return}",
    "    var settled=false;",
    "    var done=function(v){if(settled)return;settled=true;ack(d.callId,true,v)};",
    "    var fail=function(err){if(settled)return;settled=true;ack(d.callId,false,null,String(err&&err.message||err).slice(0,400))};",
    "    try{var r=h(d.args||{});",
    "      if(r&&typeof r.then==='function')r.then(done,fail);else done(r);",
    "    }catch(err){fail(err)}",
    "    return;",
    "  }",
    "  var p=d.reqId?__pending[d.reqId]:null;",
    "  if(p){delete __pending[d.reqId];if(d.ok)p.res(d.data);else p.rej(new Error(String(d.err||'宿主拒绝')))}",
    "});",
    "try{",
    "  (function(){",
    code,
    "  })();",
    `  try{self.postMessage({type:${JSON.stringify(MOD_READY)},n:__NONCE})}catch(e){}`,
    "}catch(err){",
    `  try{self.postMessage({type:${JSON.stringify(MOD_ERROR)},n:__NONCE,phase:'eval',err:String(err&&err.message||err).slice(0,400)})}catch(e){}`,
    "}",
    "})();",
  ].join("\n");
  return lockdownSource(nonce) + "\n" + bridge;
}
