import { readFileSync, writeFileSync } from "node:fs";

const token = readFileSync("docs/token/github token.txt", "utf8").trim();
if (!token) throw new Error("empty token file");
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const repo = `uartix-e2e-ui-${stamp}`;

const list = await (await fetch("http://127.0.0.1:9333/json")).json();
const page = list.find((t) => t.type === "page" && String(t.url).includes("1420"));
if (!page) throw new Error("Tauri page not found");

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener("open", res, { once: true });
  ws.addEventListener("error", rej, { once: true });
});
let id = 0;
const waits = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waits.has(m.id)) {
    waits.get(m.id)(m);
    waits.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const n = ++id;
    waits.set(n, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
    ws.send(JSON.stringify({ id: n, method, params }));
  });
const ev = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (expression, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ev(expression).catch(() => false)) return true;
    await sleep(250);
  }
  return false;
};
const clickText = async (text) =>
  ev(`(() => { const b=[...document.querySelectorAll('button')].find((x)=>x.textContent.includes(${JSON.stringify(text)})); if(!b) return false; b.click(); return true; })()`);

await send("Page.navigate", { url: "http://localhost:1420/?welcome=0&open=settings/mcp" });
if (!(await waitFor(`!!document.querySelector('input[placeholder*="github_pat"]')`, 20000))) throw new Error("token field missing");
await ev(`(() => { const el=document.querySelector('input[placeholder*="github_pat"]'); el.focus(); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(el,''); el.dispatchEvent(new Event('input',{bubbles:true})); return true; })()`);
await sleep(300);
await send("Input.insertText", { text: token });
await sleep(400);
const tokenLen = await ev(`document.querySelector('input[placeholder*="github_pat"]').value.length`);
if (tokenLen !== token.length) throw new Error(`token field length ${tokenLen} != ${token.length}`);

await send("Page.navigate", { url: "http://localhost:1420/p162-seed.html" });
if (!(await waitFor(`!!document.querySelector('.plg-item-main')`, 20000))) throw new Error("plugins not seeded");
await ev(`document.querySelector('.plg-item-main').click()`);
if (!(await waitFor(`!!document.querySelector('.plg-detail')`, 10000))) throw new Error("plugin detail missing");
if (!(await clickText("发布到 GitHub"))) throw new Error("publish button missing");
if (!(await waitFor(`!!document.querySelector('.plg-publish')`, 10000))) throw new Error("publish form missing");

await ev(`(() => { const el=document.querySelector('.plg-publish input.input'); const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; set.call(el, ${JSON.stringify(repo)}); el.dispatchEvent(new Event('input',{bubbles:true})); return el.value; })()`);
const cb = await ev(`(() => { const el=document.querySelector('.plg-publish input[type=checkbox]'); if(!el) return null; el.click(); return el.checked; })()`);
await ev(`document.querySelector('.plg-publish .btn.primary').click()`);
if (!(await waitFor(`!!document.querySelector('.plg-publish-ok, .plg-publish-warn')`, 45000))) throw new Error("publish result timeout");

const result = await ev(`(() => {
  const ok=document.querySelector('.plg-publish-ok');
  const warn=document.querySelector('.plg-publish-warn');
  return { ok: !!ok, text: (ok || warn || {}).textContent || '', repo: ${JSON.stringify(repo)}, private: ${cb} };
})()`);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(".tmp/p171/publish-ok.png", Buffer.from(shot.data, "base64"));

const repoUrl = /https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+/.exec(result.text)?.[0] || "";
let api = null;
if (repoUrl) {
  const apiUrl = repoUrl.replace("https://github.com/", "https://api.github.com/repos/");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "uartix-p171" };
  const get = await fetch(apiUrl, { headers });
  const body = await get.json().catch(() => ({}));
  const [manifest, readme, topics] = await Promise.all([
    fetch(apiUrl + '/contents/plugin.uartix.json', { headers }),
    fetch(apiUrl + '/contents/README.md', { headers }),
    fetch(apiUrl + '/topics', { headers }),
  ]);
  const topicBody = await topics.json().catch(() => ({}));
  api = { get: get.status, private: body.private, defaultBranch: body.default_branch, manifest: manifest.status, readme: readme.status, topics: topics.status, topicNames: topicBody.names };
  const del = await fetch(apiUrl, { method: "DELETE", headers });
  api.delete = del.status;
}
console.log(JSON.stringify({ tokenLen, repo, result, repoUrl, api }, null, 2));
ws.close();
