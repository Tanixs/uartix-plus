/**
 * P99c-C1a：市场**装链内核**（一个执行核，两份投影）。
 *
 * 为什么要单独一层：装包这件事接下来有两个入口——市场页的确认框（N4）与命令行
 * `uartix plugin install`（P99c R1）。两处各写一遍"要不要装、装成什么、装完什不生效"，
 * 就会有一天 UI 说"已装同名版本"而 CLI 却去 stage。所以判定只在这里，投影只负责问人。
 *
 * 四条边界（都不是风格偏好）：
 *  1. **包里多出索引没声明的能力 ⇒ 拒**（§6-3：提权必须先在货架上露出来）；少带能力放过，
 *     但要点名——"货架写了你没带"是作者常犯的错，不说他以为装上了；
 *  2. **装完不自动启用**：内核一次都不碰 `setEnabled`（P99a-B 的红线不因有市场而松动）；
 *  3. **审批成本按 §8-44 分**：装新包不弹卡（停用态、可卸载、一次性）；**覆盖已有版本**要人点头
 *     ⇒ 内核只 `proposeUpdate` 存候选，批准权在调用方（`approveUpdate` 选项）；
 *  4. **上游任一环节报错都不许落到 `stagePackage`**：取回（含 sha256 比对）、JSON、生产校验器、
 *     id 对不上——四条都在 plan 阶段返回，装的那一步看不见坏输入。
 */
import { validateManifest, type PluginManifest } from "../plugins/pluginManifest";
import { approveUpdate, getPlugin, installStaged, proposeUpdate, stagePackage } from "../plugins/pluginStore";
import { capFacts, formatBytes } from "./marketBrowse";
import { compareInstall, urlHost, type InstallState, type MarketEntry } from "./marketIndex";
import { fetchPackage } from "./marketStore";

export type InstallAction = "install" | "update" | "same" | "downgrade";
/** 对照状态 → 装链动作（穷举 Record：加状态忘了配，编译期就红） */
const ACTION_OF: Record<InstallState, InstallAction> = {
  absent: "install",
  update: "update",
  same: "same",
  "newer-than-shelf": "downgrade",
};
export const ACTION_LABEL: Record<InstallAction, string> = {
  install: "全新装入（停用态，随时可卸载）",
  update: "覆盖已有版本（要人点头）",
  same: "本机已是同版本",
  downgrade: "本机比货架新",
};

export type InstallCode =
  | "ok"
  | "fetch_failed"
  | "json_bad"
  | "invalid_manifest"
  | "id_mismatch"
  | "undeclared_capability"
  | "already_same"
  | "downgrade"
  | "install_failed"
  | "update_failed";

export interface MarketPlan {
  ok: boolean;
  code: InstallCode;
  msg: string;
  entry: MarketEntry;
  manifest: PluginManifest | null;
  action: InstallAction;
  currentVersion: string;
  host: string;
  sizeText: string;
  sha12: string;
  caps: ReturnType<typeof capFacts>;
  /** extra＝包里多出的（一律拒）；missing＝货架写了包里没带（放过但点名） */
  diff: { extra: string[]; missing: string[] };
}

/** 取包 → 校验 → 与货架声明比能力 → 定动作。任何一步不过就是一句人话的拒绝原因。 */
export async function planMarketInstall(entry: MarketEntry): Promise<MarketPlan> {
  const base = {
    entry,
    manifest: null as PluginManifest | null,
    action: "install" as InstallAction,
    currentVersion: getPlugin(entry.id)?.pkg.version ?? "",
    host: urlHost(entry.packageUrl),
    // 失败路径上不显示这个数；成功路径下面会用**实际字节**覆盖它
    sizeText: formatBytes(entry.bytes),
    sha12: entry.sha256.slice(0, 12),
    caps: capFacts(entry.capabilities),
    diff: { extra: [] as string[], missing: [] as string[] },
  };
  /** 计划不过就是"不装 + 一句原因"，动作一律记 same：投影不许拿失败计划去显示"全新装入" */
  const bad = (code: InstallCode, msg: string, extra: Partial<MarketPlan> = {}): MarketPlan => ({
    ...base, ok: false, code, msg, action: "same", ...extra,
  });
  const fetched = await fetchPackage(entry);
  if (!fetched.ok) return bad("fetch_failed", fetched.msg || "取回失败（原因未给出）");
  let raw: unknown;
  try {
    raw = JSON.parse(fetched.text);
  } catch (e) {
    return bad("json_bad", `包体不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
  const v = validateManifest(raw);
  if (!v.ok || !v.manifest) return bad("invalid_manifest", v.errors.join("；") || "包没过生产校验器");
  if (v.manifest.id !== entry.id) {
    return bad("id_mismatch", `包里的 id（${v.manifest.id}）与货架条目（${entry.id}）不是一个：装下去会占别人的坑`);
  }
  const declared = new Set<string>(entry.capabilities);
  const actual = new Set<string>(v.manifest.capabilities);
  const extra = v.manifest.capabilities.filter((c) => !declared.has(c));
  const missing = entry.capabilities.filter((c) => !actual.has(c));
  if (extra.length) {
    return bad(
      "undeclared_capability",
      `包里带着货架没声明的能力：${extra.join("、")}——已拒绝入库。提权必须先写在货架上，不然"看能力清单"这件事就没意义了`,
      { diff: { extra, missing } },
    );
  }
  const state = compareInstall(entry, base.currentVersion || undefined);
  return {
    ...base,
    ok: true,
    code: "ok",
    msg: "",
    action: ACTION_OF[state],
    manifest: v.manifest,
    // 装之前给人看的数得是他真拿到的数，所以这里覆盖成实际字节
    sizeText: formatBytes(fetched.bytes),
    caps: capFacts(v.manifest.capabilities),
    diff: { extra, missing },
  };
}

/** 给确认框与 CLI 共用的那段人话：说清"会碰到什么"，也照实说没做的动作。 */
export function describePlan(plan: MarketPlan): string {
  if (!plan.ok) return plan.msg;
  const e = plan.entry;
  const bits = [
    `${ACTION_LABEL[plan.action]}：${e.name} v${e.version}`,
    plan.currentVersion ? `本机 v${plan.currentVersion}` : "本机未装",
    `包体来自 ${plan.host}`,
    plan.sizeText,
    `sha256 ${plan.sha12}…（装前已按货架声明比对）`,
  ];
  if (plan.caps.length) bits.push(`会用到的能力：${plan.caps.map((c) => c.name).join("、")}`);
  else bits.push("这个包不声明任何能力");
  const blocked = plan.caps.filter((c) => c.blocked);
  if (blocked.length) bits.push(`其中「${blocked.map((c) => c.name).join("、")}」不属于自动放行集，启用后也不会自己生效`);
  if (plan.diff.missing.length) bits.push(`货架上写了但这个包没带：${plan.diff.missing.join("、")}`);
  bits.push("装进来是停用态，要你再去启用才会生效（我不会自动启用）");
  return bits.join(" · ");
}

export interface InstallOutcome {
  ok: boolean;
  code: InstallCode;
  msg: string;
}

/**
 * 落地。**不弹卡、不自动启用**：要不要批准覆盖由调用方决定（UI 的确认框 / CLI 的 `--yes`），
 * 所以 `approveUpdate` 默认 false——默认少动一次本机。
 */
export async function installMarketPackage(
  entry: MarketEntry,
  opts: { approveUpdate?: boolean } = {},
): Promise<InstallOutcome> {
  const plan = await planMarketInstall(entry);
  if (!plan.ok || !plan.manifest) return { ok: false, code: plan.code, msg: plan.msg };
  const e = plan.entry;
  if (plan.action === "same") {
    return { ok: false, code: "already_same", msg: `本机已经是 v${plan.currentVersion}，不做处理（不重装、不覆盖）` };
  }
  if (plan.action === "downgrade") {
    return {
      ok: false,
      code: "downgrade",
      msg: `本机 v${plan.currentVersion} 比货架 v${e.version} 新：拒绝降级覆盖。要回退用插件库里的「回滚」（那里有历史版本）`,
    };
  }
  if (plan.action === "install") {
    const staged = stagePackage(plan.manifest);
    if (!staged.ok || !staged.stagingId) {
      return { ok: false, code: "invalid_manifest", msg: staged.errors.join("；") || "暂存失败" };
    }
    const done = installStaged(staged.stagingId);
    if (!done.ok) return { ok: false, code: "install_failed", msg: done.msg };
    return { ok: true, code: "ok", msg: `${describePlan(plan)}｜已装入插件库，状态：停用` };
  }
  const proposed = proposeUpdate(e.id, plan.manifest);
  if (!proposed.ok) return { ok: false, code: "update_failed", msg: proposed.msg };
  if (!opts.approveUpdate) {
    return {
      ok: true,
      code: "ok",
      msg: `${describePlan(plan)}｜候选 v${e.version} 已暂存，还没覆盖本机 v${plan.currentVersion}：批准后才换`,
    };
  }
  const approved = approveUpdate(e.id);
  if (!approved.ok) return { ok: false, code: "update_failed", msg: approved.msg };
  return { ok: true, code: "ok", msg: `${describePlan(plan)}｜已批准并切到 v${e.version}（旧版本进历史，可回滚）` };
}
