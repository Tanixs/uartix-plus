/**
 * P88b-3 §9.1：声明式面板/控件渲染器（宿主可信代码）。
 * 将 DeclarativeBlock 集合渲染为自包含 HTML 文档，数据链路复用 uartix 桥
 * （widgetBridge 注入的 window.uartix.onSnap），缺通道显示「待绑定」，不伪造数据。
 * 渲染发生在宿主侧，产物进入影子扩展后仍受 iframe 沙箱/CSP 约束（§11）。
 */

interface MetricBlock { type: "metric"; title: string; channel?: string; unit?: string; precision?: number }
interface SparkBlock { type: "spark"; title: string; channel: string; seconds?: number }
interface TextBlock { type: "text"; title?: string; text: string }
interface HtmlBlock { type: "html"; html: string }
export type AnyBlock = MetricBlock | SparkBlock | TextBlock | HtmlBlock;

export interface RenderCtx {
  title?: string;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderBlock(b: AnyBlock): string {
  switch (b.type) {
    case "metric":
      return `<div class="ux-block ux-metric" data-ch="${esc(b.channel ?? "")}" data-prec="${b.precision ?? 3}" data-unit="${esc(b.unit ?? "")}">
  <div class="ux-metric-title">${esc(b.title)}${b.channel ? "" : '<span class="ux-bind-miss">待绑定</span>'}</div>
  <div class="ux-metric-val">--</div>
</div>`;
    case "spark":
      return `<div class="ux-block ux-spark" data-ch="${esc(b.channel)}" data-win="${Math.min(Math.max(Math.round((b.seconds ?? 60) * 20), 20), 600)}">
  <div class="ux-metric-title">${esc(b.title)}</div>
  <canvas class="ux-spark-cv" width="260" height="56"></canvas>
  <div class="ux-spark-val">--</div>
</div>`;
    case "text":
      return `<div class="ux-block ux-text">${b.title ? `<div class="ux-metric-title">${esc(b.title)}</div>` : ""}<div class="ux-text-body">${esc(b.text).replace(/\n/g, "<br>")}</div></div>`;
    case "html":
      // 受限自定义块：内容经尺寸限额校验；运行在沙箱 iframe 内无宿主对象
      return `<div class="ux-block ux-html">${b.html}</div>`;
  }
}

const STYLE = `
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:10px;font:13px/1.5 var(--ux-font,system-ui,sans-serif);background:transparent;color:var(--ux-text,#1c2733)}
.ux-block{background:var(--ux-bg-panel,rgba(127,127,127,.08));border:1px solid var(--ux-border,rgba(127,127,127,.25));border-radius:8px;padding:8px 10px;margin-bottom:8px}
.ux-metric-title{font-size:11px;opacity:.72;display:flex;justify-content:space-between;gap:8px}
.ux-metric-val{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;margin-top:2px}
.ux-metric-val .ux-unit{font-size:12px;font-weight:400;opacity:.7;margin-left:4px}
.ux-bind-miss{font-size:10px;color:var(--ux-warn,#b7791f);border:1px solid currentColor;border-radius:4px;padding:0 4px;margin-left:6px}
.ux-spark-cv{display:block;width:100%;height:56px;margin-top:4px}
.ux-spark-val{font-size:11px;opacity:.8;font-variant-numeric:tabular-nums}
.ux-text-body{white-space:normal}
.ux-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}
`;

const SCRIPT = `
(function(){
if(!window.uartix)return;
var hist={};
function pick(snap,ch){if(!ch)return undefined;return snap.fields[ch]}
function tick(snap){
 var els=document.querySelectorAll("[data-ch]");
 for(var i=0;i<els.length;i++){var el=els[i];var ch=el.getAttribute("data-ch");if(!ch)continue;
  var v=pick(snap,ch);
  var miss=el.querySelector(".ux-bind-miss");
  if(v===undefined){if(!miss){var t=el.querySelector(".ux-metric-title");if(t){var s=document.createElement("span");s.className="ux-bind-miss";s.textContent="待绑定";t.appendChild(s)}}}
  else if(miss)miss.remove();
  if(el.classList.contains("ux-metric")){
   var val=el.querySelector(".ux-metric-val");if(!val)continue;
   var unit=el.getAttribute("data-unit")||"";
   var prec=parseInt(el.getAttribute("data-prec")||"3",10);
   var n=Number(v);
   if(Number.isFinite(n)){val.innerHTML=String((+n.toFixed(prec)).toString())+(unit?'<span class="ux-unit">'+unit+"</span>":"")}
   else{val.textContent=String(v)}
  }else if(el.classList.contains("ux-spark")){
   var n2=Number(v);
   if(!Number.isFinite(n2))continue;
   var win=parseInt(el.getAttribute("data-win")||"120",10);
   var h=hist[ch]||(hist[ch]=[]);
   h.push(n2);if(h.length>win)h.shift();
   var cv=el.querySelector("canvas");
   var sv=el.querySelector(".ux-spark-val");
   if(sv)sv.textContent=ch+" = "+(+n2.toFixed(3)).toString();
   if(!cv)continue;
   var ctx=cv.getContext("2d");if(!ctx)continue;
   var w=cv.width,ht=cv.height;
   ctx.clearRect(0,0,w,ht);
   if(h.length<2)continue;
   var mn=Infinity,mx=-Infinity;for(var j=0;j<h.length;j++){if(h[j]<mn)mn=h[j];if(h[j]>mx)mx=h[j]}
   if(mx-mn<1e-9){mx=mn+1}
   ctx.beginPath();
   for(var k=0;k<h.length;k++){
    var x=k/(h.length-1)*w;
    var y=ht-4-((h[k]-mn)/(mx-mn))*(ht-8);
    if(k===0)ctx.moveTo(x,y);else ctx.lineTo(x,y);
   }
   var acc=getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()||"#4a89dc";
   ctx.strokeStyle=acc;ctx.lineWidth=1.5;ctx.stroke();
  }
 }
}
uartix.onSnap(tick);
if(uartix.snap())tick(uartix.snap());
})();`;

/** 拼接闭合标签，避免源码中出现字面 </script>（no-useless-escape 规避）。 */
const SCRIPT_END = "</" + "script>";

/** 渲染声明式面板/小部件为完整 HTML（数据经 uartix 桥；缺通道由运行时标注待绑定）。 */
export function renderDeclarativeHtml(blocks: AnyBlock[], ctx: RenderCtx = {}): string {
  const metrics = blocks.filter((b) => b.type === "metric");
  const others = blocks.filter((b) => b.type !== "metric");
  const body = [
    metrics.length ? `<div class="ux-grid">${metrics.map(renderBlock).join("")}</div>` : "",
    ...others.map(renderBlock),
  ]
    .filter(Boolean)
    .join("\n");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>${STYLE}</style>
</head>
<body>
${ctx.title ? `<div class="ux-metric-title" style="margin-bottom:6px">${esc(ctx.title)}</div>` : ""}
${body}
<script>${SCRIPT}${SCRIPT_END}
</body>
</html>`;
}
