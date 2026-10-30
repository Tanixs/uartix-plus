/**
 * P177-C：官方权重下载器（`runner/download_job.py`）对着**本地假 HTTP 服务**的判据。
 *
 * 为什么不打真 GitHub：这些判据要能在断网、代理坏掉、CI 上照样跑；而且"404 / 断流 / 续传 /
 * SHA 不符 / 磁盘不够"这几种情况在真站上没法按需复现。假服务能精确制造每一种。
 *
 * 下载器本身只认 https + 主机白名单；测试用 `--insecure` 打开"回环 http + 自签证书"这一条，
 * 生产路径（插件调用）从不传它。
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { validateExtension } from "../src/features/plugins/engine/manifest.ts";
import { flattenPermissions, trustDigestInput } from "../src/features/plugins/engine/repo.ts";
import { httpsDownload } from "../plugins/uartix.yolo/main.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, "..", "plugins", "uartix.yolo", "runner", "download_job.py");
const PLUGIN = path.join(HERE, "..", "plugins", "uartix.yolo");

/** 找一个能跑的 python：优先用户那套 conda（真机），退回 PATH 里的。 */
const PY = (() => {
  for (const p of ["D:/projects/anaconda3/envs/yolo_env/python.exe", "python", "python3"]) {
    try {
      execFileSync(p, ["--version"], { stdio: "pipe" });
      return p;
    } catch {
      /* 下一个 */
    }
  }
  return "";
})();

const dir = mkdtempSync(path.join(tmpdir(), "uartix-yolo-dl-"));
afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
});

function payload(bytes, seed) {
  const b = Buffer.alloc(bytes);
  let x = seed || 7;
  for (let i = 0; i < bytes; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    b[i] = x & 0xff;
  }
  return b;
}

const sha = (b) => createHash("sha256").update(b).digest("hex");

/** 起一个本地服务，返回 { port, close }。`handler(req,res,ctx)` 自己决定怎么答。 */
function serve(handler) {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => handler(req, res));
    s.listen(0, "127.0.0.1", () => resolve({ s, port: s.address().port, close: () => new Promise((r) => s.close(r)) }));
  });
}

/** 跑一次下载器，收集 JSON 行与退出码。 */
function runDl(args, opts) {
  return new Promise((resolve) => {
    const child = spawn(PY, [RUNNER, ...args], { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString("utf8")));
    child.stderr.on("data", (d) => (err += d.toString("utf8")));
    if (opts && opts.onSpawn) opts.onSpawn(child);
    child.on("exit", (code) => {
      const lines = out
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { type: "text", text: l };
          }
        });
      resolve({ code, lines, err, out });
    });
  });
}

const baseArgs = (port, out, extra) => [
  "--url",
  `http://127.0.0.1:${port}/w.pt`,
  "--out",
  out,
  "--allow-hosts",
  "127.0.0.1",
  "--insecure",
  "--timeout",
  "10",
  ...(extra || []),
];

describe.skipIf(!PY)("P177-C · 下载器：成功 / 404 / 断流续传 / SHA / 上限 / 取消", () => {
  it("成功下载：进度行 + done + SHA256 正确 + .part 不残留", async () => {
    const body = payload(1_500_000, 3);
    const srv = await serve((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, { "Content-Length": String(body.length) });
        return res.end();
      }
      const range = req.headers.range;
      if (range) {
        const start = Number(/bytes=(\d+)-/.exec(range)[1]) || 0;
        res.writeHead(206, { "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}`, "Content-Length": String(body.length - start) });
        return res.end(body.subarray(start));
      }
      res.writeHead(200, { "Content-Length": String(body.length) });
      res.end(body);
    });
    const out = path.join(dir, "ok", "w.pt");
    try {
      const r = await runDl(baseArgs(srv.port, out, ["--expect-sha256", sha(body)]));
      expect(r.code, r.err).toBe(0);
      const done = r.lines.find((x) => x.type === "done");
      expect(done, JSON.stringify(r.lines)).toBeTruthy();
      expect(done.ok).toBe(true);
      expect(done.bytes).toBe(body.length);
      expect(done.sha256).toBe(sha(body));
      expect(r.lines.some((x) => x.type === "progress"), "没有进度行，面板会是死的").toBe(true);
      expect(existsSync(out)).toBe(true);
      expect(readFileSync(out).equals(body)).toBe(true);
      expect(existsSync(out + ".part")).toBe(false);
    } finally {
      await srv.close();
    }
  }, 60_000);

  it("404 直接报错，不白等三次重试", async () => {
    const srv = await serve((req, res) => {
      res.writeHead(404, { "Content-Length": "0" });
      res.end();
    });
    const out = path.join(dir, "404", "w.pt");
    try {
      const r = await runDl(baseArgs(srv.port, out));
      expect(r.code).toBe(3);
      const e = r.lines.find((x) => x.type === "error");
      expect(e).toBeTruthy();
      expect(e.message).toContain("404");
      expect(r.lines.some((x) => x.type === "retry"), "404 不该重试").toBe(false);
      expect(existsSync(out)).toBe(false);
    } finally {
      await srv.close();
    }
  }, 60_000);

  it("断流后重试并从 .part 续传，最终文件完整", async () => {
    const body = payload(1_200_000, 11);
    let hits = 0;
    const srv = await serve((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, { "Content-Length": String(body.length) });
        return res.end();
      }
      hits += 1;
      const range = req.headers.range;
      const start = range ? Number(/bytes=(\d+)-/.exec(range)[1]) || 0 : 0;
      if (hits === 1) {
        // 第一次：发一半就掐断（Content-Length 仍说全量，模拟连接被重置）
        res.writeHead(range ? 206 : 200, {
          "Content-Length": String(body.length - start),
          ...(range ? { "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
        });
        res.write(body.subarray(start, start + Math.floor(body.length / 2)));
        setTimeout(() => res.destroy(), 30);
        return;
      }
      res.writeHead(206, { "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}`, "Content-Length": String(body.length - start) });
      res.end(body.subarray(start));
    });
    const out = path.join(dir, "resume", "w.pt");
    try {
      const r = await runDl(baseArgs(srv.port, out, ["--expect-sha256", sha(body)]));
      expect(r.code, JSON.stringify(r.lines) + r.err).toBe(0);
      expect(r.lines.some((x) => x.type === "retry"), "断流后应能看到重试行").toBe(true);
      expect(readFileSync(out).equals(body), "续传拼出来的文件必须逐字节一致").toBe(true);
      expect(hits).toBeGreaterThan(1);
    } finally {
      await srv.close();
    }
  }, 90_000);

  it("SHA 不符：报错、不落到最终路径、.part 留着供诊断", async () => {
    const body = payload(300_000, 5);
    const srv = await serve((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, { "Content-Length": String(body.length) });
        return res.end();
      }
      res.writeHead(200, { "Content-Length": String(body.length) });
      res.end(body);
    });
    const out = path.join(dir, "sha", "w.pt");
    try {
      const r = await runDl(baseArgs(srv.port, out, ["--expect-sha256", "0".repeat(64)]));
      expect(r.code).toBe(3);
      expect(r.lines.find((x) => x.type === "error").message).toContain("SHA256");
      expect(existsSync(out)).toBe(false);
      expect(existsSync(out + ".part"), "SHA 不符时 .part 要留着").toBe(true);
    } finally {
      await srv.close();
    }
  }, 60_000);

  it("超过单文件上限：先拒，不开始下载", async () => {
    const body = payload(2_000_000, 9);
    const srv = await serve((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, { "Content-Length": String(body.length) });
        return res.end();
      }
      res.writeHead(200, { "Content-Length": String(body.length) });
      res.end(body);
    });
    const out = path.join(dir, "cap", "w.pt");
    try {
      const r = await runDl(baseArgs(srv.port, out, ["--max-bytes", "1000"]));
      expect(r.code).toBe(3);
      expect(r.lines.find((x) => x.type === "error").message).toContain("上限");
      expect(existsSync(out)).toBe(false);
    } finally {
      await srv.close();
    }
  }, 60_000);

  it("取消：进程被杀后 .part 保留（下次能续传）", async () => {
    const body = payload(4_000_000, 13);
    const srv = await serve((req, res) => {
      if (req.method === "HEAD") {
        res.writeHead(200, { "Content-Length": String(body.length) });
        return res.end();
      }
      res.writeHead(200, { "Content-Length": String(body.length) });
      let at = 0;
      const tick = setInterval(() => {
        if (at >= body.length) {
          clearInterval(tick);
          return res.end();
        }
        res.write(body.subarray(at, at + 65536));
        at += 65536;
      }, 40);
      res.on("close", () => clearInterval(tick));
    });
    const out = path.join(dir, "cancel", "w.pt");
    let child = null;
    try {
      const r = await runDl(baseArgs(srv.port, out), {
        onSpawn: (c) => {
          child = c;
          setTimeout(() => c.kill(), 700);
        },
      });
      expect(child).toBeTruthy();
      expect(r.code === 0 || r.code === null || r.code === 1, `被杀不该算成功（code=${r.code}）`).toBe(true);
      expect(existsSync(out), "取消不能留下最终文件").toBe(false);
      const part = out + ".part";
      expect(existsSync(part), "取消后 .part 必须保留").toBe(true);
      expect(statSync(part).size).toBeGreaterThan(0);
    } finally {
      await srv.close();
    }
  }, 60_000);

  it("主机不在白名单 / 非 https：在下载前就拒（不产生任何文件）", async () => {
    const out = path.join(dir, "blocked", "w.pt");
    const r = await runDl(["--url", "https://example.com/w.pt", "--out", out, "--allow-hosts", "127.0.0.1"]);
    expect(r.code).toBe(2);
    expect(r.lines.find((x) => x.type === "error").message).toContain("白名单");
    expect(existsSync(out)).toBe(false);
    const r2 = await runDl(["--url", "ftp://127.0.0.1/w.pt", "--out", out, "--allow-hosts", "127.0.0.1", "--insecure"]);
    expect(r2.code).toBe(2);
    expect(r2.lines.find((x) => x.type === "error").message).toContain("https");
  }, 30_000);
});

describe("P177-C · 权限面与包内文件数", () => {
  const manifest = JSON.parse(readFileSync(path.join(PLUGIN, "plugin.json"), "utf8"));

  it("声明了 net.connect 的三台主机（批准卡会因此重来一次）", () => {
    // P178 起还要装环境：新增了 PyPI / PyTorch / 国内镜像的域名
    for (const h of ["github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", "pypi.org", "files.pythonhosted.org", "download.pytorch.org", "mirrors.ustc.edu.cn", "mirror.nju.edu.cn", "mirrors.aliyun.com", "pypi.tuna.tsinghua.edu.cn"]) {
      expect(manifest.permissions.net.connect, `缺 ${h}`).toContain(h);
    }
    const v = validateExtension(manifest);
    expect(v.errors, JSON.stringify(v.errors)).toEqual([]);
    // 真实流程里 install 会先把 inject 补成默认值；清单本身可以不写，这里照做
    const rows = flattenPermissions({ ...manifest, inject: { sections: [], mutations: [] } });
    for (const host of manifest.permissions.net.connect) expect(rows, "批准卡要能看到联网行").toContain(`联网 ${host}`);
  });

  it("net 进 trust digest：加不加联网，指纹必须不同（否则批准卡不会重来）", () => {
    const without = JSON.parse(JSON.stringify(manifest));
    delete without.permissions.net;
    expect(trustDigestInput(manifest)).not.toBe(trustDigestInput(without));
  });

  it("包内 11 个文件（上限 12）：加的是 download_job.py", () => {
    const files = [];
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (["node_modules", ".versions", "logs", "__pycache__"].includes(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(path.relative(PLUGIN, p).replace(/\\/g, "/"));
      }
    };
    walk(PLUGIN);
    expect(files).toContain("runner/download_job.py");
    expect(files.length).toBe(11);
    expect(files.length).toBeLessThanOrEqual(12);
    // 包里不许有 .pyc：发布通道会当二进制跳过，还会让"几个文件"说谎
    expect(files.some((f) => f.endsWith(".pyc"))).toBe(false);
  });
});

/**
 * P178-A：插件自己的下载器（`main.mjs` 里的 `httpsDownload`）。
 *
 * uv 本体（约 34MB）就是走这条路径拿的 —— 它要是坏了，**每一台新机器都装不上**。
 * 同样用本地假服务制造重定向 / 续传 / 404，判据落在"落盘字节"上而不是"有没有抛错"。
 * 只认 https 的规矩没破：`insecure` 只在回环地址上放行明文，生产路径不传。
 */
describe("P178-A · 插件下载器（uv 引导）", () => {
  const tmp = (n) => path.join(dir, `dl-${n}-${Math.random().toString(36).slice(2, 7)}`);

  it("200 直给：字节数对得上、.part 不残留、进度回调递增", async () => {
    const body = payload(300_000, 11);
    const srv = await serve((req, res) => {
      res.writeHead(200, { "Content-Length": String(body.length) });
      res.end(body);
    });
    try {
      const out = tmp("ok");
      const seen = [];
      const r = await httpsDownload(`http://127.0.0.1:${srv.port}/uv.zip`, out, {
        insecure: true,
        onProgress: (done, total) => seen.push([done, total]),
      });
      expect(readFileSync(out).equals(body)).toBe(true);
      expect(existsSync(out + ".part")).toBe(false);
      expect(r.bytes).toBe(body.length);
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[seen.length - 1][0]).toBe(body.length);
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("302 重定向：跟到第二跳，内容仍是完整文件（镜像站常用这套）", async () => {
    const body = payload(120_000, 5);
    const srv = await serve((req, res) => {
      if (req.url === "/uv.zip") {
        res.writeHead(302, { Location: "http://127.0.0.1:" + req.socket.localPort + "/real/uv.zip" });
        return res.end();
      }
      res.writeHead(200, { "Content-Length": String(body.length) });
      res.end(body);
    });
    try {
      const out = tmp("302");
      await httpsDownload(`http://127.0.0.1:${srv.port}/uv.zip`, out, { insecure: true });
      expect(readFileSync(out).equals(body)).toBe(true);
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("断在半路：.part 留着，下次从断点续（Range 生效，不从头再来）", async () => {
    const body = payload(400_000, 9);
    let rangeSeen = "";
    const srv = await serve((req, res) => {
      const from = Number(String(req.headers.range || "").replace(/[^\d]/g, "")) || 0;
      rangeSeen = req.headers.range || "";
      if (from > 0) {
        res.writeHead(206, { "Content-Length": String(body.length - from), "Content-Range": `bytes ${from}-${body.length - 1}/${body.length}` });
        return res.end(body.subarray(from));
      }
      // 第一趟：只给前一半就断开。**必须等 write 的 flush 回调**再 destroy——
      // 直接 `res.destroy()` 会把还没发出去的数据丢掉，客户端只会看到"socket hang up"，
      // 那不是"断在半路"，测不到续传。
      res.writeHead(200, { "Content-Length": String(body.length) });
      res.write(body.subarray(0, 200_000), () => setTimeout(() => res.destroy(), 30));
    });
    try {
      const out = tmp("resume");
      await expect(httpsDownload(`http://127.0.0.1:${srv.port}/uv.zip`, out, { insecure: true })).rejects.toBeTruthy();
      expect(existsSync(out + ".part"), "断流后 .part 必须留着才能续").toBe(true);
      const half = statSync(out + ".part").size;
      expect(half).toBeGreaterThan(0);
      expect(half).toBeLessThan(body.length);
      await httpsDownload(`http://127.0.0.1:${srv.port}/uv.zip`, out, { insecure: true });
      expect(rangeSeen, "第二趟必须带 Range 头").toContain("bytes=");
      expect(readFileSync(out).equals(body), "续传后的文件必须和原件逐字节一致").toBe(true);
      expect(existsSync(out + ".part")).toBe(false);
    } finally {
      await srv.close();
    }
  }, 40_000);

  it("404 / 5xx：报错带状态码，不留半截文件", async () => {
    const srv = await serve((req, res) => {
      res.writeHead(req.url === "/404.zip" ? 404 : 500);
      res.end("nope");
    });
    try {
      await expect(httpsDownload(`http://127.0.0.1:${srv.port}/404.zip`, tmp("404"), { insecure: true })).rejects.toThrow(/404/);
      await expect(httpsDownload(`http://127.0.0.1:${srv.port}/500.zip`, tmp("500"), { insecure: true })).rejects.toThrow(/HTTP 500/);
    } finally {
      await srv.close();
    }
  }, 30_000);

  it("非回环地址不给明文口子：http://example.com 仍走 https（等于拒掉）", async () => {
    await expect(httpsDownload("http://example.com/uv.zip", tmp("plain"), { insecure: true })).rejects.toBeTruthy();
  }, 20_000);
});
