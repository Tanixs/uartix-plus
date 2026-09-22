/**
 * 内控桥的 Node 侧客户端（P99c-C1b 从 `mcp-cli.ts` 抽出来，两个 CLI 共用一份）。
 *
 * 为什么必须抽而不是复制：这里管的是**发现文件在哪、token 怎么握手、单行上限多少**——
 * 两条 CLI 各写一遍，将来改一处漏一处（比如 Windows 的 APPDATA 路径或 token 长度门槛），
 * 表现就是"某个 CLI 突然连不上而另一个正常"，最难查。
 *
 * 一次调用 = 一次短连接（connect → auth → call → 一行回执 → close）：
 * 零状态，所以应用重启、换端口、断线都不需要客户端恢复逻辑。
 */
import { connect, type Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const MAX_LINE = 1024 * 1024;
export const CONNECT_TIMEOUT_MS = 2000;
export const AUTH_TIMEOUT_MS = 2000;
/** 应用侧桥的固定 3 s 上限（bridge.rs `CALL_TIMEOUT`）：客户端再长也等不到，别在这里放宽 */
export const CALL_TIMEOUT_MS = 5000;

export interface Endpoint {
  port: number;
  token: string;
  pid: number;
  version: string;
}

export interface Capabilities {
  capabilities?: { jobs?: { version?: number } };
}

/** MCP 发现文件的候选路径（`UARTIX_ENDPOINT` 优先，给测试与非常规安装留一口） */
export function discoverPaths(): string[] {
  const name = join("com.uartix.plus", "mcp-endpoint.json");
  const out: string[] = [];
  const override = process.env.UARTIX_ENDPOINT;
  if (override) out.push(override);
  if (platform() === "win32") {
    out.push(join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), name));
  } else if (platform() === "darwin") {
    out.push(join(homedir(), "Library", "Application Support", name));
  } else {
    out.push(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), name));
  }
  return out;
}

export function readEndpoint(): Endpoint {
  const paths = discoverPaths();
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const e = JSON.parse(readFileSync(p, "utf8")) as Partial<Endpoint>;
      if (typeof e.port === "number" && typeof e.token === "string" && e.token.length >= 16) {
        return { port: e.port, token: e.token, pid: e.pid ?? 0, version: e.version ?? "?" };
      }
    } catch (err) {
      console.error("[uartix-bridge] 发现文件损坏（" + p + "）：", err);
    }
  }
  throw new Error(
    `找不到 Uartix+ 的 MCP 发现文件（已查找：${paths.join("、")}）。请先启动 Uartix+，并在 设置 → 集成 打开「启用 MCP 桥」`,
  );
}

export interface CallOptions {
  /** 拿到 auth 回执后、发 call 前的检查：返回字符串就是错误（例如 jobs 能力不匹配） */
  afterAuth?: (auth: Capabilities) => string | undefined;
  /** 只要能力不要结果：auth 成功即收工（MCP 侧的 `__capabilities` 探测） */
  stopAfterAuth?: boolean;
  timeoutMs?: number;
  log?: (...a: unknown[]) => void;
}

/** 一次桥调用。失败一律 reject 一句人能读的话（不静默重试：应用侧动作可能不可逆）。 */
export function bridgeCall<T = unknown>(
  ep: Endpoint,
  kind: string,
  args: Record<string, unknown>,
  opts: CallOptions = {},
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket: Socket = connect({ host: "127.0.0.1", port: ep.port });
    const log = opts.log ?? ((...a: unknown[]) => console.error("[uartix-bridge]", ...a));
    let buf = "";
    let step: "auth" | "call" = "auth";
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(err);
    };
    const arm = (ms: number, phase: string) => {
      clearTimeout(timer);
      timer = setTimeout(
        () => fail(new Error(`${phase} timeout; query the same jobId / idempotency key, do not silently rerun`)),
        ms,
      );
    };
    arm(CONNECT_TIMEOUT_MS, "connect");
    socket.on("close", () => {
      if (!settled) fail(new Error("bridge disconnected before receipt; no automatic retry"));
    });
    socket.on("error", (e) => fail(new Error(`连不上 Uartix+（127.0.0.1:${ep.port}）：${e.message}`)));
    socket.on("connect", () => {
      arm(AUTH_TIMEOUT_MS, "authentication");
      socket.write(JSON.stringify({ op: "auth", token: ep.token }) + "\n");
    });
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      if (Buffer.byteLength(buf) > MAX_LINE) return fail(new Error("bridge response exceeds line limit"));
      for (;;) {
        const i = buf.indexOf("\n");
        if (i < 0) break;
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg: { ok?: boolean; err?: string; data?: T };
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // 半行/脏数据：忽略等下一行
        }
        if (step === "auth") {
          if (msg.ok !== true) {
            return fail(new Error(msg.err === "busy" ? "已有另一个 MCP 会话在线" : "token 校验失败（应用端重新生成过？）"));
          }
          const auth = (msg.data ?? {}) as Capabilities;
          if (opts.stopAfterAuth) {
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            resolve(msg.data as T);
            return;
          }
          const problem = opts.afterAuth?.(auth);
          if (problem) return fail(new Error(problem));
          step = "call";
          arm(opts.timeoutMs ?? CALL_TIMEOUT_MS, "RPC");
          socket.write(JSON.stringify({ op: "call", reqId: 1, kind, args }) + "\n");
          log(`已鉴权，发出 ${kind}`);
          continue;
        }
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (msg.ok === true) resolve(msg.data as T);
        else reject(new Error(msg.err ?? "Uartix+ 返回未知错误"));
        return;
      }
    });
  });
}
