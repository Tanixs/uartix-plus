/**
 * P174-R19：市场卡片的**状态判据**（纯函数，可单测）。
 *
 * 为什么单独成模块：这一层的输出直接决定用户看到的是「安装」还是「更新 0.2.0 → 0.2.3」，
 * 而这两句话的差别是"能不能升"。写在 `.tsx` 里就只能靠肉眼验收；写在这里，
 * 版本比较的边界（缺位、多段、预发布、非数字）才有地方钉。
 *
 * 一条取向：**读不到远端版本就说"不知道"，不猜"可更新"**。猜错的代价是用户点下去
 * 结果原地装了一遍同版本；而"没反应"最多是少一个按钮。
 */
import type { GhRepo } from "./ghSearch";

/** 一枚已装插件在市场里要露出的那几项（其余字段视图用不到，别拖进来）。 */
export interface MarketInstalled {
  version: string;
  enabled: boolean;
  /** 权限面是否已批准（verdict === "trusted"）。没批准的"已启用"是假的。 */
  trusted: boolean;
}

export type MarketState =
  /** 没装过 */
  | "absent"
  /** 装着，且远端没有更新的版本（或远端版本还没读到） */
  | "installed"
  /** 装着，但仓库里的版本更高 ⇒ 该给「更新」 */
  | "updatable"
  /** 装着，但版本比已装的旧（仓库回退了 / 本地是测试版）：只说"已安装"，不催降版本 */
  | "behind";

/**
 * 比两个版本号。`a > b` 返回正数，相等 0，`a < b` 负数，**认不出返回 null**。
 *
 * 只吃 `1.2.3` 这种点分数字（允许尾挂 `-beta.1` 预发布标记：同数字时预发布算更小，
 * 与 semver 一致）。清单校验里版本必须就是这个形状，所以这里不为 `v1.2`、`1.2.3.4`
 * 之外的写法兜底——兜底会把"读不懂"伪装成"相等"，那正是"该更新却没按钮"的成因。
 */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    const d = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (d !== 0) return d;
  }
  // 数字段相同：无预发布 > 有预发布（1.0.0 比 1.0.0-beta 新）
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;
  if (!pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre);
}

const NUM = /^\d+$/;

function parseVersion(raw: string): { core: number[]; pre: string } | null {
  const s = String(raw ?? "").trim().replace(/^v/i, "");
  if (!s) return null;
  const [head, ...rest] = s.split("-");
  const pre = rest.join("-");
  const parts = head.split(".");
  if (!parts.length || parts.length > 3) return null;
  const core: number[] = [];
  for (const p of parts) {
    if (!NUM.test(p)) return null;
    core.push(Number(p));
  }
  while (core.length < 3) core.push(0);
  return { core, pre };
}

/**
 * 这枚仓库相对本机是什么状态。`remote` 传空 = 还没读到（或读失败）⇒ 绝不报"可更新"。
 */
export function marketStateOf(installed: MarketInstalled | undefined, remote?: string): MarketState {
  if (!installed) return "absent";
  const d = remote ? compareVersions(remote, installed.version) : null;
  if (d === null || d === undefined) return "installed";
  if (d > 0) return "updatable";
  if (d < 0) return "behind";
  return "installed";
}

export type MarketFilter = "all" | "absent" | "installed" | "updatable";

export type MarketSort = "updated" | "stars" | "name";

/** 「已装」这一档把 updatable / behind 也算进去：用户找的是"我装过的"，不是版本差。 */
const MATCHES: Record<Exclude<MarketFilter, "all">, MarketState[]> = {
  absent: ["absent"],
  installed: ["installed", "updatable", "behind"],
  updatable: ["updatable"],
};

export function filterRepos(
  repos: readonly GhRepo[],
  filter: MarketFilter,
  stateOf: (repo: GhRepo) => MarketState,
): GhRepo[] {
  if (filter === "all") return [...repos];
  const ok = new Set(MATCHES[filter]);
  return repos.filter((r) => ok.has(stateOf(r)));
}

/**
 * 排序。GitHub 的返回本来就是"最近更新"，所以 `updated` 保持原序，
 * 不重排——重排会把引擎给的相关性顺序打散，而那是搜索词命中度的唯一信号。
 */
export function sortRepos(repos: readonly GhRepo[], sort: MarketSort): GhRepo[] {
  const out = [...repos];
  if (sort === "stars") return out.sort((a, b) => b.stars - a.stars || a.full.localeCompare(b.full));
  if (sort === "name") return out.sort((a, b) => a.full.localeCompare(b.full));
  return out;
}

/**
 * 已装插件在市场里还要不要提"启用/批准"。
 *
 * 只说真话：`trusted` 为假时"已启用"是假的——引擎那边面板根本不会出现。
 * 这两件事在市场里合成一句，是为了让用户搜到自己那枚时不用切回插件管理去确认状态。
 */
export function installedNote(inst: MarketInstalled): "ready" | "disabled" | "unapproved" {
  if (!inst.trusted) return "unapproved";
  if (!inst.enabled) return "disabled";
  return "ready";
}
