/**
 * P174-A14：GitHub 话题检索的**契约层**（纯函数，不碰网络）。
 *
 * 为什么"市场"这条路是 GitHub 话题而不是自建货架：
 * - 自建货架要有人审、有人合并、有人发版，否则它会停在三个月前的样子；
 * - 话题（`topic:uartix-plugin`）让"投稿"退化成"给你的仓库打个话题"——谁都不用等谁；
 * - 而信任不靠"货架审过"，靠**同一张批准卡**：装的时候权限面还是逐条给你看。
 *
 * 这一层只做三件事：拼查询 URL、把 JSON 读成 `GhRepo[]`、拼归档地址。
 * 真正的网络在 `marketClient.ts`（`market_fetch` 那条白名单通道）。
 */

/** 本项目的投稿话题。改这里等于改整个生态的约定，不是随手能改的一行。 */
export const PLUGIN_TOPIC = "uartix-plugin";

export interface GhRepo {
  /** `owner/name`。它是这个仓库在这一层的唯一身份（同一仓库改名只变这一处）。 */
  full: string;
  owner: string;
  name: string;
  description: string;
  stars: number;
  /** ISO 时间串，原样显示（格式化交给界面，契约层不做本地化）。 */
  updated: string;
  defaultBranch: string;
  htmlUrl: string;
  topics: string[];
  archived: boolean;
}

export interface SearchQuery {
  /** 用户输入的关键词（可空）。 */
  text?: string;
  /** 话题；空串 = 不限话题（搜全站是用户的选择，不是默认）。 */
  topic?: string;
  /** 每页条数，1..50（GitHub 上限 100，这里不给那么多：一屏 30 条已经够）。 */
  perPage?: number;
  sort?: "updated" | "stars" | "best-match";
}

const clampPerPage = (n: number | undefined): number => {
  const v = Math.floor(Number(n ?? 30));
  if (!Number.isFinite(v) || v <= 0) return 30;
  return Math.min(50, Math.max(1, v));
};

/**
 * 拼检索地址。
 *
 * 关键词里的 `"` 与换行会被 GitHub 语法吃掉，拼之前先换成空格——
 * 否则用户输入 `foo"bar` 会把查询变成另一条（现象是"搜不到，也不报错"）。
 */
export function searchUrl(q: SearchQuery): string {
  const parts: string[] = [];
  const text = String(q.text ?? "")
    .replace(/["\r\n\t]+/g, " ")
    .trim();
  if (text) parts.push(text);
  /**
   * `undefined` = 没指定 ⇒ **默认带话题**；`""` = 用户明确关掉了话题过滤。
   * 这两种必须是两种行为：把 app 的默认值写成"空串"会把"要不要搜全站"这件事
   * 变成调用方忘了传参数时的静默后果。
   */
  const topic = q.topic === undefined ? PLUGIN_TOPIC : String(q.topic).trim();
  if (topic) parts.push(`topic:${topic}`);
  const qual = parts.join(" ").trim() || `topic:${PLUGIN_TOPIC}`;
  const sort = q.sort ?? "updated";
  const tail = sort === "best-match" ? "" : `&sort=${sort}&order=desc`;
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(qual)}&per_page=${clampPerPage(q.perPage)}${tail}`;
}

interface GhRawItem {
  full_name?: unknown;
  name?: unknown;
  owner?: { login?: unknown };
  description?: unknown;
  stargazers_count?: unknown;
  updated_at?: unknown;
  default_branch?: unknown;
  html_url?: unknown;
  topics?: unknown;
  archived?: unknown;
}

function toRepo(it: GhRawItem): GhRepo | null {
  const full = typeof it.full_name === "string" ? it.full_name : "";
  if (!full.includes("/")) return null;
  const [owner, name] = full.split("/");
  return {
    full,
    owner,
    name: typeof it.name === "string" && it.name ? it.name : name,
    description: typeof it.description === "string" ? it.description : "",
    stars: typeof it.stargazers_count === "number" ? it.stargazers_count : 0,
    updated: typeof it.updated_at === "string" ? it.updated_at : "",
    defaultBranch: typeof it.default_branch === "string" && it.default_branch ? it.default_branch : "main",
    htmlUrl: typeof it.html_url === "string" ? it.html_url : `https://github.com/${full}`,
    topics: Array.isArray(it.topics) ? it.topics.filter((t): t is string => typeof t === "string") : [],
    archived: it.archived === true,
  };
}

export interface SearchResult {
  repos: GhRepo[];
  total: number;
  /** GitHub 的限流说明（未登录 10 次/分钟，被限了要能说清楚，而不是"空结果"）。 */
  rateLimited: boolean;
}

/**
 * 读 GitHub 的搜索响应。
 *
 * **单条坏了只丢那一条**（同市场索引的口径）：一支别人的坏投稿不该让整个搜索结果空掉。
 * 但信封坏了（不是 JSON / 不是对象）要明确报错——"没有结果"和"读不懂响应"是两件事。
 */
export function parseSearchResponse(json: string): { ok: true; data: SearchResult } | { ok: false; msg: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, msg: "GitHub 返回的不是 JSON（可能是代理/网络中间页）" };
  }
  if (!raw || typeof raw !== "object") return { ok: false, msg: "GitHub 返回的响应形状不对" };
  const obj = raw as { items?: unknown; total_count?: unknown; message?: unknown };
  if (!Array.isArray(obj.items)) {
    const msg = typeof obj.message === "string" ? obj.message : "";
    if (/rate limit/i.test(msg)) {
      return { ok: true, data: { repos: [], total: 0, rateLimited: true } };
    }
    return { ok: false, msg: msg || "响应里没有 items（GitHub API 变了？）" };
  }
  const repos: GhRepo[] = [];
  for (const it of obj.items as GhRawItem[]) {
    const r = toRepo(it ?? {});
    if (r) repos.push(r);
  }
  return {
    ok: true,
    data: {
      repos,
      total: typeof obj.total_count === "number" ? obj.total_count : repos.length,
      rateLimited: false,
    },
  };
}

/**
 * 归档地址：`codeload.github.com` 直给 200。
 *
 * 不用 `api.github.com/repos/../tarball`：那条会 302 到 codeload，而取回通道**刻意不跟重定向**
 * （跟过去就等于白名单能用一次跳转绕出去）。这里直接写最终地址，一跳都不欠。
 */
export function tarballUrl(repo: Pick<GhRepo, "owner" | "name" | "defaultBranch">): string {
  const branch = String(repo.defaultBranch || "main").replace(/[^\w./-]/g, "");
  return `https://codeload.github.com/${repo.owner}/${repo.name}/tar.gz/refs/heads/${branch || "main"}`;
}

/** 话题是否命中（界面上给"确认是插件"一个明确的徽章，而不是靠描述里出现关键词）。 */
export function hasPluginTopic(repo: GhRepo, topic: string = PLUGIN_TOPIC): boolean {
  return repo.topics.some((t) => t.toLowerCase() === topic.toLowerCase());
}
