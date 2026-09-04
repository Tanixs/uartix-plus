/**
 * 沙箱组件 JS API 桥：注入到小部件/面板/自定义卡片 HTML 的 <head> 顶部，
 * 提供全局 window.uartix —— AI 生成内容无需手写 postMessage 样板即可获得
 * 数据快照、AI 对话状态（思维链）、键盘、鼠标、提问 AI、窗口控制等能力。
 *
 * 无边框形态（chrome:none）内置：按住即拖（dragDelta 手动增量，松开停靠、
 * 自动钳制屏幕边界）、右键弹菜单（可被 uartix.menu 自定义/多菜单/关闭）。
 * 原始 aiw:* postMessage 协议仍然可用（与本桥共存）。
 */

function buildScript(bare: boolean): string {
  return `(function(){
if(window.uartix)return;
var pending={},seq=0,perms={},screen=null,lastSnap=null,lastChat=null,themeVars=null,themeName="";
var subs={snap:[],chat:[],key:[],cursor:[],menu:[],theme:[],bc:[]};
var menus={},menuOff=false,menuDefault="default";
function post(m){try{parent.postMessage(m,"*")}catch(e){}}
function applyTheme(vars,theme){
if(vars){themeVars=vars;for(var k in vars){try{document.documentElement.style.setProperty(k,vars[k])}catch(e){}}}
if(theme){themeName=theme;document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme==="dark"||theme==="navy"||theme==="glaze"?"dark":"light"}
subs.theme.forEach(function(f){try{f({vars:themeVars,theme:themeName})}catch(e){}});
}
function rpc(m){return new Promise(function(res){var id="q"+(++seq);m.reqId=id;pending[id]=res;post(m)})}
function sub(arr,f,data){arr.push(f);if(data!==undefined&&data!==null){try{f(data)}catch(e){}}return function(){var i=arr.indexOf(f);if(i>=0)arr.splice(i,1)}}
function syncMenus(){post({type:"aiw:menu-def",menus:menus,off:menuOff,def:menuDefault})}
window.addEventListener("message",function(e){
var d=e.data;if(!d||typeof d.type!="string")return;
if(d.type==="aiw:init"){perms=(d.perms)||{};if(d.screen)screen=d.screen}
else if(d.type==="aiw:screen"){screen=d.screen}
else if(d.type==="aiw:snap"){lastSnap=d.snap;subs.snap.forEach(function(f){try{f(d.snap)}catch(x){}})}
else if(d.type==="aiw:chat"){lastChat=d.feed;subs.chat.forEach(function(f){try{f(d.feed)}catch(x){}})}
else if(d.type==="aiw:key"){subs.key.forEach(function(f){try{f(d)}catch(x){}})}
else if(d.type==="aiw:cursor"){subs.cursor.forEach(function(f){try{f(d)}catch(x){}})}
else if(d.type==="aiw:menu-pick"){subs.menu.forEach(function(f){try{f(d.id,d.menu)}catch(x){}})}
else if(d.reqId&&pending[d.reqId]){var c=pending[d.reqId];delete pending[d.reqId];c(d)}
});
function fireKey(e){if(!subs.key.length)return;var k={type:e.type,key:e.key,code:e.code,ctrlKey:!!e.ctrlKey,shiftKey:!!e.shiftKey,altKey:!!e.altKey,metaKey:!!e.metaKey};subs.key.forEach(function(f){try{f(k)}catch(x){}})}
document.addEventListener("keydown",fireKey);
document.addEventListener("keyup",fireKey);
var api={
onSnap:function(f){return sub(subs.snap,f,lastSnap)},
snap:function(){return lastSnap},
onChat:function(f){return sub(subs.chat,f,lastChat)},
chat:function(){return lastChat},
onKey:function(f){return sub(subs.key,f)},
onCursor:function(f){post({type:"aiw:cursor",on:true});return sub(subs.cursor,f)},
onMenu:function(f){return sub(subs.menu,f)},
onTheme:function(f){return sub(subs.theme,f,themeVars?{vars:themeVars,theme:themeName}:null)},
theme:function(){return themeVars},
perms:function(){return perms},
screen:function(){return screen},
send:function(text,mode){return rpc({type:"aiw:send",mode:mode==="hex"?"hex":"ascii",text:String(text)}).then(function(d){if(!d.ok)throw new Error(d.err||"发送失败");return d})},
ask:function(text){return rpc({type:"aiw:ask",text:String(text)}).then(function(d){if(!d.ok)throw new Error(d.err||"提交失败");return d})},
app:function(kind,args){return rpc({type:"aiw:app",action:{kind:kind,args:args||{}}}).then(function(d){if(!d.ok)throw new Error(d.err||"动作失败");return d})},
toast:function(msg){return api.app("toast",{msg:String(msg)})},
resize:function(h){post({type:"aiw:resize",height:Math.round(h)})},
broadcast:function(topic,data){try{var s=JSON.stringify(data===undefined?null:data);if(s&&s.length>60000)throw new Error("广播数据过大(>60KB)");post({type:"aiw:x2w",topic:String(topic),data:data})}catch(e){return Promise.reject(String(e&&e.message||e))}},
onBroadcast:function(f){return sub(subs.bc,f)},
speak:function(text,opts){return new Promise(function(res,rej){
if(!window.speechSynthesis)return rej("当前环境不支持语音合成");
try{window.speechSynthesis.cancel();var u=new SpeechSynthesisUtterance(String(text));if(opts){if(opts.rate)u.rate=+opts.rate;if(opts.pitch)u.pitch=+opts.pitch;if(opts.lang)u.lang=String(opts.lang);}
u.onend=function(){res()};u.onerror=function(e){rej(String(e&&e.error||"播报失败"))};window.speechSynthesis.speak(u);}catch(e){rej(String(e&&e.message||e))}
})},
speechStop:function(){try{window.speechSynthesis.cancel()}catch(e){}},
menu:{
define:function(a,b,c){var name="default",items=a,opts=b||{};if(typeof a=="string"){name=a;items=b;opts=c||{}}
menus[name]={items:items||[],system:opts.system!==false};syncMenus()},
remove:function(name){delete menus[name||"default"];syncMenus()},
show:function(name,x,y){post({type:"aiw:win",action:"menu",menu:name||menuDefault,x:x,y:y})},
setDefault:function(name){if(name)menuDefault=String(name);syncMenus()},
off:function(){menuOff=true;syncMenus()},
on:function(){menuOff=false;syncMenus()}
},
win:{
drag:function(){},
menu:function(x,y){post({type:"aiw:win",action:"menu",menu:menuDefault,x:x,y:y})},
close:function(){post({type:"aiw:win",action:"close"})},
popOut:function(){post({type:"aiw:win",action:"popOut"})},
moveTo:function(x,y){post({type:"aiw:win",action:"move",x:+x||0,y:+y||0})},
moveBy:function(dx,dy){post({type:"aiw:win",action:"moveBy",dx:+dx||0,dy:+dy||0})},
resizeTo:function(w,h){post({type:"aiw:win",action:"size",w:+w||0,h:+h||0})},
top:function(on){post({type:"aiw:win",action:"alwaysOnTop",on:on!==false})},
through:function(on){post({type:"aiw:win",action:"ignoreCursorEvents",on:on!==false})},
get:function(){return rpc({type:"aiw:win",action:"get"}).then(function(d){return d.ok?d.data:null})}
}
};
window.uartix=api;
post({type:"aiw:ready"});
${
  bare
    ? `var dn=null,acc={dx:0,dy:0},raf=0;
function flushDelta(){raf=0;if(!dn)return;if(acc.dx||acc.dy){post({type:"aiw:win",action:"dragDelta",dx:acc.dx,dy:acc.dy});acc.dx=0;acc.dy=0}}
document.addEventListener("pointerdown",function(e){
if(e.button!==0){dn=null;return}
var t=e.target;
if(t&&t.closest&&t.closest("button,input,a,textarea,select,iframe,[data-nodrag]")){dn=null;return}
dn={x:e.clientX,y:e.clientY};
try{t.setPointerCapture&&t.setPointerCapture(e.pointerId)}catch(x){}
});
document.addEventListener("pointermove",function(e){
if(!dn)return;
var dx=e.clientX-dn.x,dy=e.clientY-dn.y;
dn.x=e.clientX;dn.y=e.clientY;
if(!dx&&!dy)return;
acc.dx+=dx;acc.dy+=dy;
if(!raf)raf=requestAnimationFrame(flushDelta);
});
function endDrag(){if(dn){dn=null;post({type:"aiw:win",action:"dragEnd"})}}
document.addEventListener("pointerup",endDrag);
document.addEventListener("pointercancel",endDrag);
document.addEventListener("contextmenu",function(e){
if(menuOff)return;
e.preventDefault();
api.menu.show(menuDefault,e.clientX,e.clientY);
});`
    : ""
}
})();`;
}

/** 把桥脚本注入到 HTML 的 <head>（或 <html> 之后，或最前） */
export function injectBridge(html: string, bare: boolean): string {
  const script = `<script>${buildScript(bare)}<\/script>`;
  const head = html.match(/<head[^>]*>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + "\n" + script + html.slice(at);
  }
  const h = html.match(/<html[^>]*>/i);
  if (h && h.index !== undefined) {
    const at = h.index + h[0].length;
    return html.slice(0, at) + "\n" + script + html.slice(at);
  }
  return script + "\n" + html;
}
