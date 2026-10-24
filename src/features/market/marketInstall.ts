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
import { compareInstall, urlHost, type InstallCode, type InstallState, type MarketEntry } from "./marketIndex";
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
  if (v.manifest.version !== entry.version) {
    return bad(
      "version_mismatch",
      `货架说这条是 v${entry.version}，包体里那份其实是 v${v.manifest.version}：不装——要不要覆盖是按哪个数判的，本身就说不清`,
    );
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

/**
 * 一句"装这条会发生什么"需要的全部事实。
 *
 * 为什么把这句话拆成"事实 + 渲染"两段（C2 逼出来的）：批准卡上那句**必须在下载之前**拼好
 * （assess 不联网，见 `agent/marketTools.ts`），而计划过了之后那句要用**实际拿到**的数。
 * 两处各写一遍，就会有一天批准卡说"2 KB"而回执说"2 MB"。
 */
export interface PlanFacts {
  name: string;
  version: string;
  currentVersion: string;
  host: string;
  sizeText: string;
  sha12: string;
  caps: ReturnType<typeof capFacts>;
  /** 声明阶段还没读包，所以两侧都是空——空就是不提（不是"没差异"） */
  diff: { extra: string[]; missing: string[] };
  action: InstallAction;
  /** true＝包已取回并按货架声明比对过；false＝数字仍只是货架的声明 */
  verified: boolean;
}

/** 声明阶段那份事实：只读索引条目与本机版本，一次网络都不碰。 */
export function factsFromEntry(entry: MarketEntry, currentVersion: string): PlanFacts {
  return {
    name: entry.name,
    version: entry.version,
    currentVersion,
    host: urlHost(entry.packageUrl),
    sizeText: formatBytes(entry.bytes),
    sha12: entry.sha256.slice(0, 12),
    caps: capFacts(entry.capabilities),
    diff: { extra: [], missing: [] },
    action: ACTION_OF[compareInstall(entry, currentVersion || undefined)],
    verified: false,
  };
}

/** 那段人话的**唯一**渲染处：说清"会碰到什么"，也照实说没做的动作与数字出自哪一层。 */
export function describeFacts(f: PlanFacts): string {
  const bits = [
    `${ACTION_LABEL[f.action]}：${f.name} v${f.version}`,
    f.currentVersion ? `本机 v${f.currentVersion}` : "本机未装",
    // 同源货架那条没有域名（应用自带的那份索引），空着说出去就成了"包体来自  ·"
    `包体来自 ${f.host || "应用自带的同源货架"}`,
    f.sizeText,
    f.verified
      ? `sha256 ${f.sha12}…（装前已按货架声明比对）`
      : `sha256 ${f.sha12}…（以下数字都取自货架声明，包还没下载）`,
  ];
  if (f.caps.length) bits.push(`会用到的能力：${f.caps.map((c) => c.name).join("、")}`);
  else bits.push("这个包不声明任何能力");
  const blocked = f.caps.filter((c) => c.blocked);
  if (blocked.length) bits.push(`其中「${blocked.map((c) => c.name).join("、")}」不属于自动放行集，启用后也不会自己生效`);
  if (f.diff.missing.length) bits.push(`货架上写了但这个包没带：${f.diff.missing.join("、")}`);
  bits.push("装进来是停用态，要你再去启用才会生效（我不会自动启用）");
  return bits.join(" · ");
}

/** 给确认框、CLI 与 AI 回执共用的那句计划（失败就回内核原话，不另编一句好听的）。 */
export function describePlan(plan: MarketPlan): string {
  if (!plan.ok) return plan.msg;
  const e = plan.entry;
  return describeFacts({
    name: e.name,
    version: e.version,
    currentVersion: plan.currentVersion,
    host: plan.host,
    sizeText: plan.sizeText,
    sha12: plan.sha12,
    caps: plan.caps,
    diff: plan.diff,
    action: plan.action,
    verified: true,
  });
}

export interface InstallOutcome {
  ok: boolean;
  code: InstallCode;
  msg: string;
}

/** 暂存句柄：两条路径的"已经拿到、还没落地"的差别就在这一枚上。 */
export type StagedHandle =
  | { action: "install"; entryId: string; stagingId: string }
  | { action: "update"; entryId: string; manifest: PluginManifest };

/**
 * 暂存。**新装**走 `stagePackage`（内存暂存，不动库）；**覆盖**只把候选留在调用方手里，
 * 一次都不叫 `proposeUpdate`——那会把插件状态翻成 `update_pending`，等于在用户批准之前
 * 先把正在跑的版本摘下来（副作用反了：应该是"点了才动"）。
 */
export function stageMarketPlan(plan: MarketPlan): InstallOutcome & { handle?: StagedHandle } {
  if (!plan.ok || !plan.manifest) return { ok: false, code: plan.code, msg: plan.msg };
  if (plan.action === "same") {
    return { ok: false, code: "already_same", msg: `本机已经是 v${plan.currentVersion}，不做处理（不重装、不覆盖）` };
  }
  if (plan.action === "downgrade") {
    return {
      ok: false,
      code: "downgrade",
      msg: `本机 v${plan.currentVersion} 比货架 v${plan.entry.version} 新：拒绝降级覆盖。要回退用插件库里的「回滚」（那里有历史版本）`,
    };
  }
  if (plan.action === "update") {
    return { ok: true, code: "ok", msg: "", handle: { action: "update", entryId: plan.entry.id, manifest: plan.manifest } };
  }
  const staged = stagePackage(plan.manifest);
  if (!staged.ok || !staged.stagingId) {
    return { ok: false, code: "invalid_manifest", msg: staged.errors.join("；") || "暂存失败" };
  }
  return { ok: true, code: "ok", msg: "", handle: { action: "install", entryId: plan.entry.id, stagingId: staged.stagingId } };
}

/**
 * 落地。**只有人在本机点过之后才允许调到这里**（市场页按钮 / CLI 触发后应用内的确认卡），
 * 所以这里不再问"批不批"——`update` 走到这一步就意味着已批准。仍然一次都不叫 `setEnabled`。
 */
export function applyMarketStage(handle: StagedHandle, describeText: string): InstallOutcome {
  if (handle.action === "install") {
    const done = installStaged(handle.stagingId);
    if (!done.ok) return { ok: false, code: "stale_staging", msg: done.msg };
    return { ok: true, code: "ok", msg: `${describeText}｜已装入插件库，状态：停用` };
  }
  const proposed = proposeUpdate(handle.entryId, handle.manifest);
  if (!proposed.ok) return { ok: false, code: "update_failed", msg: proposed.msg };
  const approved = approveUpdate(handle.entryId);
  if (!approved.ok) return { ok: false, code: "update_failed", msg: approved.msg };
  return { ok: true, code: "ok", msg: `${describeText}｜已批准并切换（旧版本进历史，可回滚）` };
}
