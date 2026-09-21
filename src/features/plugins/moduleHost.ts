/**
 * P99a-B1：`module` 产物的 Worker 宿主。
 *
 * B1 只做一件事，并且把它做完：**在真 Worker 里跑一遍封网自证**，通不过就不让这个包启用。
 * 常驻句柄、工具注册、调用超时强杀都在 B2——那里才需要"这个 worker 还活着"这件事，
 * 现在写一个没人调的 `call()` 就是投机取巧（详设 §5.3）。
 *
 * 环约束（§8-33）：本文件只准依赖 `moduleLockdown`（字符串叶子）。它被 pluginStore 在求值期
 * 路径上碰到，所以任何"往上层 store 伸手"的 import 都会把白屏风险再演一遍。
 */
import { MOD_ERROR, MOD_PROBE, moduleWorkerSource, type ModuleProbe } from "./moduleLockdown";
import { MAX_MODULE_BYTES } from "./artifact";

export interface ModuleProbeResult extends ModuleProbe {
  /** 插件代码求值期抛出的错误（探针过不过都要如实带上，否则"模块没反应"无法归因） */
  evalError?: string;
  /** 结论从哪来：真 Worker，还是根本没有 Worker（后者一律判失败） */
  note: string;
}

const PROBE_TIMEOUT_MS = 3000;

function newNonce(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    }
  } catch {
    /* 退到下面的随机串 */
  }
  return `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 对一个 `module` 产物做封网自证。
 *
 * 跑的是**完整** worker 源（封网 + 桥 + 插件代码），不是简化版：插件代码求值之后的那个 realm
 * 才是它将来真正住下的地方，只测引导脚本等于测了一份不会上线的替身。
 */
export function probeModuleCode(code: string, pkgId: string): Promise<ModuleProbeResult> {
  if (typeof code !== "string" || !code.trim()) {
    return Promise.resolve({ ok: false, failed: ["empty-code"], note: "模块代码为空" });
  }
  if (code.length > MAX_MODULE_BYTES) {
    return Promise.resolve({
      ok: false,
      failed: ["code-too-large"],
      note: `模块代码 ${code.length} 字节，超过 ${MAX_MODULE_BYTES} 上限`,
    });
  }
  const g = globalThis as {
    Worker?: new (url: string) => {
      terminate: () => void;
      addEventListener: (t: string, fn: (e: { data: unknown }) => void) => void;
    };
    Blob?: typeof Blob;
    URL?: typeof URL;
  };
  const WorkerC = g.Worker;
  const BlobC = g.Blob;
  const UrlC = g.URL;
  if (!WorkerC || !BlobC || !UrlC) {
    /**
     * fail-closed：没有 Worker 就没有隔离，"测不了"不等于"通过"。
     * 纯浏览器里跑 `npm run dev` 时 Worker 是在的，所以这条只会在 node 测试环境命中——
     * 那边用 `moduleLockdown.test.ts` 的 vm 通道验引导脚本逻辑，两件事不互相顶替。
     */
    return Promise.resolve({
      ok: false,
      failed: ["no-worker"],
      note: "当前环境没有 Worker：模块不会运行（封网无法证明＝不启用）",
    });
  }
  const nonce = newNonce();
  const src = moduleWorkerSource(code, nonce, pkgId);
  return new Promise<ModuleProbeResult>((resolve) => {
    let settled = false;
    let evalError: string | undefined;
    let url = "";
    let w: { terminate: () => void; addEventListener: (t: string, fn: (e: { data: unknown }) => void) => void } | null = null;
    const finish = (r: ModuleProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        w?.terminate();
      } catch {
        /* 已经死了 */
      }
      try {
        if (url) UrlC.revokeObjectURL(url);
      } catch {
        /* 回收失败不影响结论 */
      }
      resolve({ ...r, ...(evalError ? { evalError } : {}) });
    };
    try {
      url = UrlC.createObjectURL(new BlobC([src], { type: "text/javascript" }));
      w = new WorkerC(url);
    } catch (err) {
      finish({
        ok: false,
        failed: ["worker-spawn-failed"],
        note: `Worker 起不来：${String((err as Error)?.message ?? err).slice(0, 160)}`,
      });
      return;
    }
    const timer = setTimeout(
      () => finish({ ok: false, failed: ["probe-timeout"], note: "worker 未在时限内回报探针结果" }),
      PROBE_TIMEOUT_MS,
    );
    w.addEventListener("message", (e) => {
      const d = e.data as { type?: string; n?: string; ok?: boolean; failed?: string[]; err?: string };
      if (!d || typeof d.type !== "string" || d.n !== nonce) return; // 伪造/串台的消息一概不看
      if (d.type === MOD_ERROR) {
        evalError = String(d.err ?? "").slice(0, 400);
        return;
      }
      if (d.type !== MOD_PROBE) return;
      finish({
        ok: !!d.ok,
        failed: Array.isArray(d.failed) ? d.failed : ["probe-malformed"],
        note: d.ok ? "真 Dedicated Worker 内实测：出网原语已全部摘除" : "封网探针失败：下列原语仍可取得",
      });
    });
    w.addEventListener("error", () => {
      finish({ ok: false, failed: ["worker-error"], note: "worker 启动即报错，封网状态未知" });
    });
  });
}

/** 一个包里的全部 `module` 产物（按 entry 路径稳定排序，供启用闸门与 UI 共用一份读法）。 */
export function moduleArtifactsOf(
  pkg: { artifacts: Record<string, Record<string, unknown>> },
): { entry: string; code: string }[] {
  return Object.entries(pkg.artifacts)
    .filter(([, a]) => a.kind === "module")
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([entry, a]) => ({ entry, code: typeof a.code === "string" ? a.code : "" }));
}

export { MAX_MODULE_BYTES };
