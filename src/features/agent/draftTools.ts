/**
 * P174-B1 收尾：草稿态的 AI 工具（`plugin_draft_*`）。
 *
 * 这是 dsh「Creative 模式」在 AI 面的等价物：模型可以**写草稿、看草稿、丢草稿**，
 * 但草稿不是插件——它不进账本、不进信任库、不进「+面板」，也**不许启动**。
 *
 * 四条边界，一条都不松：
 * 1. `plugin_draft_save` 只往 `<appDir>/.drafts/<id>-<tag>` 写文件（路径由 `draftRelPath` 逐段判），
 *    不碰 `plugins/`；
 * 2. `plugin_draft_discard` 是删除，标 `destructive_write`——必须过人工批准卡；
 * 3. `plugin_draft_promote` **只排队**：它调 `requestDraftPromotion`，把请求放进设置 → 插件管理的
 *    待确认区，然后返回 `pending: true`。装不装由人在面板上点「转正为插件」决定；
 * 4. 这里**没有** `commitInstall` / `promoteDraft` / `stagePackage` 这类落盘动词。
 *    源文本测试钉住这一点（与 P99c-C2 的 `propose_market_install` 同一条纪律）。
 */
import { defineTool, notExecuted, type AgentToolEntry } from "./toolRegistry";

const HOST = { kind: "host" } as const;

/** 一次列多少条。总数照实报（`truncated`），草稿最多 200 份。 */
const LIST_CAP = 100;

/** 装载插件子系统的当前快照（应用数据目录 + 已装列表）。 */
async function pluginSnapshot() {
  const { ensureLoaded, getSnapshot } = await import("../plugins/engine/pluginEngine");
  await ensureLoaded();
  const snap = getSnapshot();
  if (!snap.appDir) throw new Error("读不到应用数据目录（插件子系统还没就绪）");
  return snap;
}

/** `files` 必须是「相对路径 → 文本」的平面对象；别的一律当参数错，不去猜。 */
function asFileMap(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") return null;
    out[k] = val;
  }
  return out;
}

const nameArg = (a: Record<string, unknown>) => String(a.name ?? "").trim();

export const draftToolEntries: readonly AgentToolEntry[] = Object.freeze([
  defineTool({
    name: "plugin_draft_list",
    labelZh: "列插件草稿",
    effect: "read",
    // 只读目录、不写插件库：不挂域门，预览档也能看（否则模型连"草稿有没有写成功"都确认不了）
    domain: null,
    provenance: HOST,
    description:
      "List plugin DRAFTS stored under the app data `.drafts` folder. Drafts are not installed plugins: they are not in the ledger, never appear in panels, and cannot start. " +
      "Each item reports name (the draft folder name), manifest id/title/version, validation `issue` (empty = promotable), warnings, permissions, and whether the same id is already installed. " +
      "Use this before updating or promoting a draft. No arguments.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
    summarize: () => "列插件草稿",
    execute: async (_args, ctx) => {
      const snap = await pluginSnapshot();
      const { listDrafts } = await import("../plugins/engine/draft");
      const { getDraftRequests } = await import("../plugins/engine/draftRequests");
      const installed = Object.fromEntries(snap.entries.map((e) => [e.id, e.version]));
      const all = await listDrafts(snap.appDir, installed);
      const pending = new Set(getDraftRequests().map((r) => r.name));
      return {
        callId: ctx.callId,
        ok: true,
        status: "read",
        data: {
          drafts: all.slice(0, LIST_CAP).map((d) => ({
            name: d.name,
            id: d.id,
            title: d.title,
            version: d.version,
            issue: d.issue,
            warnings: d.warnings,
            permissions: d.permissions,
            ...(d.installedVersion ? { installedVersion: d.installedVersion } : {}),
            promotionPending: pending.has(d.name),
          })),
          total: all.length,
          truncated: all.length > LIST_CAP,
          hint:
            "转正只能由用户在设置 → 插件管理确认。`promotionPending` 表示已经有一条等待用户确认的请求。",
        },
      };
    },
  }),

  defineTool({
    name: "plugin_draft_save",
    labelZh: "写插件草稿",
    effect: "draft_write",
    domain: "plugins",
    provenance: HOST,
    description:
      "Create or update a plugin DRAFT by writing UTF-8 text files into `.drafts/<id>-<tag>`. This NEVER installs, enables, stages, or runs anything — a draft is not a plugin. " +
      "Include a v3 `plugin.json` (format `uartix-plugin`, schemaVersion 3, with `id`, `version`, `name`, optional `main`/`contributes`/`permissions`). " +
      "EXACT v3 field names — guessing from the old format is the #1 reason a draft validates but silently loses its titles/handlers: panel/theme/widget/preset/task declarations are { id, title, entry } (the label field is `title`, NOT `name`; there is no `area`/`size`); commands are { id, title }; host code needs the `main` field (`main` = `main.mjs`) plus `activation: [\"onPanel:<panelId>\", \"onCommand:<commandId>\"]`; writing files at runtime needs `permissions.fs.write` (a read declaration never grants writes). Minimal panel manifest: {\"format\":\"uartix-plugin\",\"schemaVersion\":3,\"id\":\"user.demo\",\"version\":\"1.0.0\",\"name\":\"Demo\",\"main\":\"main.mjs\",\"activation\":[\"onPanel:main\"],\"permissions\":{\"ui\":{\"panel\":true},\"fs\":{\"write\":[\"$WS\"]}},\"contributes\":{\"panels\":[{\"id\":\"main\",\"title\":\"Demo\",\"entry\":\"panel.html\"}]}}. Layouts: a panel plugin uses `contributes.panels` + `panel.html` + `main.mjs` exporting `activate(ctx)`; a theme uses `contributes.themes` + a CSS entry; a widget uses `contributes.widgets` + `permissions.ui.widget` + an HTML entry that calls `uartix.call`/`uartix.on` (transparent/frameless is just a widget presentation, `transparent: true` — there is no separate “desktop pet” concept); a workspace preset uses `contributes.presets` + `permissions.ui.layout` + a JSON entry `{layout:<dockview layout>, note?}` (applying it backs up the current layout first); a task template uses `contributes.tasks` + a JSON entry `{goal, steps?:[{tool,args?,note?}]}` that only fills the AI input box and never sends. " +
      "Panel/widget HTML runs in an opaque-origin iframe: no host DOM, no `:host`, no host localStorage. The host THEME, however, IS bridged — every design token arrives renamed as `--uartix-*` (`var(--uartix-bg)`, `var(--uartix-text)`, `var(--uartix-accent)`, `var(--uartix-border)`, `var(--uartix-radius-m)`…) plus the short aliases `--bg --panel --inset --fg --dim --faint --line --accent --on-accent --ok --warn --bad`, and a ZERO-SPECIFICITY base stylesheet already paints `body`, `input`, `select`, `textarea`, `button`, `a`, `code`, scrollbars and the classes `.btn`, `.btn.primary`, `.btn.danger`, `.input`, `.card`. USE THEM: a panel that hard-codes its own grey/white scheme ignores the user's theme and reads as a bug, not a style — restate the tokens only when the panel genuinely needs a look of its own. Read the live theme via `uartix.theme()` and re-derive on change via `uartix.on(\"theme\", fn)`. Talk to the host only through uartix.call/on/readText/list/writeText/bindRoot. " +
     "File keys must be relative paths inside the draft (no absolute paths, drive letters, `..`, or empty segments). Same path overwrites; files not mentioned are left untouched. " +
      "Limits per call: 200 files, 8 MiB per file, 32 MiB total — split larger packages across calls. Args: { id, tag?, files }.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Plugin id, dot-separated lowercase (e.g. user.demo). Used as the draft folder prefix." },
        tag: { type: "string", description: "Draft variant tag; a-z0-9 only, max 12 chars. Defaults to `draft`." },
        files: {
          type: "object",
          description: "Relative file path → UTF-8 text content (e.g. { \"plugin.json\": \"{...}\", \"main.mjs\": \"...\" })",
          additionalProperties: { type: "string" },
        },
      },
      required: ["id", "files"],
      additionalProperties: false,
    },
    summarize: (a) => {
      const files = asFileMap(a.files);
      return `写草稿 ${String(a.id ?? "")}（${files ? Object.keys(files).length : 0} 个文件）`;
    },
    execute: async (a, ctx) => {
      const id = String(a.id ?? "").trim();
      const files = asFileMap(a.files);
      if (!id) return notExecuted(ctx.callId, "draft_args_invalid", { hint: "id 不能为空" });
      if (!files || !Object.keys(files).length) {
        return notExecuted(ctx.callId, "draft_args_invalid", { hint: "files 必须是非空的「相对路径 → 文本」对象" });
      }
      const snap = await pluginSnapshot();
      const { draftDirName, writeDraftFiles } = await import("../plugins/engine/draft");
      const name = draftDirName(id, String(a.tag ?? "draft"));
      try {
        const got = await writeDraftFiles(snap.appDir, name, files);
        const d = got.entry;
        /* 包里躺着一个 main.mjs，而清单没写 main：宿主**不会加载它**。
           这是"模型以为写了主进程逻辑"的典型形态（真机见过）：草稿合法、转正成功、功能静默缺失。
           它不该拦转正（那不是致命错误，也可能只是留了个草稿），但必须当场说出来。 */
        const warnings = [...d.warnings];
        if (d.manifest && !d.manifest.main && Object.prototype.hasOwnProperty.call(files, "main.mjs")) {
          warnings.push('包里有 main.mjs，但 plugin.json 没有 "main": "main.mjs"：宿主不会加载它（面板方法与命令都会缺）。');
        }
        return {
          callId: ctx.callId,
          ok: true,
          status: "applied",
          data: {
            name,
            id: d.id,
            title: d.title,
            version: d.version,
            valid: !d.issue,
            issue: d.issue,
            warnings,
            permissions: d.permissions,
            written: got.written,
            bytes: got.bytes,
            installed: false,
            runnable: false,
            next: d.issue
              ? `草稿已写入，但清单还不合法（${d.issue}）：修好之前不能转正。用 plugin_draft_save 覆盖同名文件即可。`
              : "草稿已写入。它不会安装也不会运行；要转正请调 plugin_draft_promote 把请求放进设置 → 插件管理，由用户点确认。",
          },
        };
      } catch (e) {
        return notExecuted(ctx.callId, "draft_rejected", {
          name,
          msg: String(e instanceof Error ? e.message : e),
          hint: "路径越界、体积超限或写盘失败都会在这里如实回报；没有写进草稿根之外的东西",
        });
      }
    },
  }),

  defineTool({
    name: "plugin_draft_discard",
    labelZh: "丢弃插件草稿",
    // 删除不可撤销（草稿没有快照），必须按破坏性写入走人工批准
    effect: "destructive_write",
    domain: "plugins",
    provenance: HOST,
    description:
      "Delete one plugin DRAFT folder. This is destructive and not reversible; it requires local approval on every call. " +
      "It never touches installed plugins, their ledger entries, or their trust records. Args: { name } where `name` is the draft folder name from `plugin_draft_list`.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "Draft folder name from plugin_draft_list (e.g. user.demo-v2)" } },
      required: ["name"],
      additionalProperties: false,
    },
    summarize: (a) => `丢弃草稿 ${nameArg(a)}`,
    approvalBinding: (a) => ({ tool: "plugin_draft_discard", name: nameArg(a) }),
    assess: async (a, ctx) => {
      const name = nameArg(a);
      if (!name) return { refuse: notExecuted(ctx.callId, "draft_args_invalid", { hint: "name 不能为空" }) };
      const snap = await pluginSnapshot();
      const { listDrafts } = await import("../plugins/engine/draft");
      const all = await listDrafts(snap.appDir);
      if (!all.some((d) => d.name === name)) {
        return {
          refuse: notExecuted(ctx.callId, "unknown_draft", {
            name,
            want: all.slice(0, 20).map((d) => d.name),
            hint: "name 必须来自 plugin_draft_list；草稿可能已经被丢弃",
          }),
        };
      }
      return {
        meta: { effect: "destructive_write", idempotent: true, reversible: false, mayTouchDevice: false },
        plan: `删掉草稿「${name}」及其全部文件。它不会被安装；已安装的插件不受影响。删除后无法恢复。`,
      };
    },
    execute: async (a, ctx) => {
      const name = nameArg(a);
      const snap = await pluginSnapshot();
      const { discardDraft } = await import("../plugins/engine/draft");
      const { dismissDraftPromotion } = await import("../plugins/engine/draftRequests");
      try {
        await discardDraft(snap.appDir, name);
        dismissDraftPromotion(name);
        return {
          callId: ctx.callId,
          ok: true,
          status: "applied",
          data: { name, deleted: true, installedAffected: false },
        };
      } catch (e) {
        return notExecuted(ctx.callId, "draft_discard_failed", {
          name,
          msg: String(e instanceof Error ? e.message : e),
        });
      }
    },
  }),

  defineTool({
    name: "plugin_draft_promote",
    labelZh: "请求转正插件草稿",
    /**
     * `config_write` 而不是 `protected_config`：它只往**内存里的待确认表**放一条请求，
     * 不下载、不复制、不写账本。真正的安装（以及可能出现的批准卡）发生在用户点了面板按钮之后。
     * 如果把这支也做成 protected_config，用户会先被问"允许 AI 请求转正吗"，再被问"要转正吗"——
     * 两张卡问同一件事，第一张纯属噪音。
     */
    effect: "config_write",
    domain: "plugins",
    provenance: HOST,
    description:
      "Queue a promotion request for one plugin DRAFT. It does NOT install, stage, enable, or run anything — the request appears in the plugin manager's draft section, " +
      "and only the user can turn it into an install by clicking “Promote”. If the permission surface has not been approved before, that click also opens the normal approval card. " +
      "Use `plugin_draft_list` first and only request drafts with an empty `issue`. Args: { name, note? }.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Draft folder name from plugin_draft_list" },
        note: { type: "string", description: "Optional one-line reason shown to the user (max 300 chars)" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    summarize: (a) => `请求转正草稿 ${nameArg(a)}`,
    approvalBinding: (a) => ({ tool: "plugin_draft_promote", name: nameArg(a) }),
    assess: async (a, ctx) => {
      const name = nameArg(a);
      if (!name) return { refuse: notExecuted(ctx.callId, "draft_args_invalid", { hint: "name 不能为空" }) };
      const snap = await pluginSnapshot();
      const { listDrafts } = await import("../plugins/engine/draft");
      const all = await listDrafts(snap.appDir);
      const d = all.find((x) => x.name === name);
      if (!d) {
        return {
          refuse: notExecuted(ctx.callId, "unknown_draft", {
            name,
            want: all.slice(0, 20).map((x) => x.name),
            hint: "name 必须来自 plugin_draft_list",
          }),
        };
      }
      if (d.issue || !d.manifest) {
        return {
          refuse: notExecuted(ctx.callId, "invalid_draft", {
            name,
            issue: d.issue,
            hint: "先修好清单再请求转正；转正计划必须能通过同一套校验",
          }),
        };
      }
      return {
        meta: { effect: "config_write", idempotent: true, reversible: true, mayTouchDevice: false },
        plan: `把草稿「${d.title}」v${d.version} 的转正请求放进设置 → 插件管理，等用户确认。我不会安装、不会启用、不会启动它。`,
      };
    },
    execute: async (a, ctx) => {
      const name = nameArg(a);
      const note = typeof a.note === "string" ? a.note : undefined;
      const { requestDraftPromotion } = await import("../plugins/engine/pluginEngine");
      try {
        const got = await requestDraftPromotion(name, note);
        return {
          callId: ctx.callId,
          ok: true,
          status: "validated",
          data: {
            name,
            id: got.request.id,
            title: got.request.title,
            version: got.request.version,
            verdict: got.request.verdict,
            installedVersion: got.request.installedVersion ?? "",
            permissions: got.request.permissions,
            pending: true,
            installed: false,
            staged: false,
            runnable: false,
            next:
              "请求已放进设置 → 插件管理的草稿分区（顶部会有一条「待确认」）。我到此为止：装不装由用户点「转正为插件」决定；" +
              "权限面没批过时，那一步还会弹批准卡。",
          },
        };
      } catch (e) {
        return notExecuted(ctx.callId, "draft_cannot_promote", {
          name,
          msg: String(e instanceof Error ? e.message : e),
          hint: "草稿可能已被改动或删除；先用 plugin_draft_list 看现状，不要用同样参数硬重试",
        });
      }
    },
  }),
]);
