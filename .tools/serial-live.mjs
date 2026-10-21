const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);

const port = args.port || "COM6";
const baud = Number(args.baud || 115200);
const seconds = Number(args.seconds || 5);
const cdp = Number(args.cdp || 9333);

const list = await (await fetch(`http://127.0.0.1:${cdp}/json`)).json();
const page = list.find((t) => t.type === "page" && String(t.url).includes("1420"));
if (!page) throw new Error("Tauri app page not found; run `npm run tauri dev` with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333");

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

const expression = `(async()=>{ try {
  const s = await import('/src/features/serial/serialStore.ts');
  const b = await import('/src/ipc/binbus.ts');
  let frames = 0, rows = 0, errors = 0, dropped = 0, rxMsgs = 0, rxBytes = 0;
  const offF = b.onFrames((p) => { frames++; rows += p.rows.length; errors += p.errors; dropped += p.dropped; });
  const offR = b.onRx((p) => { rxMsgs++; rxBytes += p.bytes.length; });
  s.setConfig({ port: ${JSON.stringify(port)}, baud: ${baud} });
  await s.openPort();
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, ${seconds * 1000}));
  const ms = performance.now() - t0;
  const snap = s.getSnapshot();
  await s.closePort();
  offF(); offR();
  return {
    status: snap.status, error: snap.error, ms,
    rxTotal: snap.rxTotal, txTotal: snap.txTotal, bps: snap.bps,
    frames, rows, errors, dropped, rxMsgs, rxBytes,
    rowsPerSec: rows / (ms / 1000), rxBytesPerSec: rxBytes / (ms / 1000),
  };
} catch (e) { return { error: String((e && e.message) || e) }; } })()`;

const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
console.log(JSON.stringify(r.result?.value ?? r.result, null, 2));
ws.close();
