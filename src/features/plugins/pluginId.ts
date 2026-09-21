/**
 * P92 D2：Agent 产物的插件 id 生成（纯函数）。
 *
 * 为什么不是 slug：旧实现 `name.toLowerCase().replace(/[^a-z0-9]+/g,"-")` 会把中文整个吃掉，
 * 「AI 助手现代玻璃风」→ `user.agent.theme-ai`，纯中文名一律退化成 `user.agent.theme-theme`。
 * 两份**不同**的中文主题因此会撞成同一个 id，而"同 id 即原地升版"的保存策略会让第二份
 * 静默覆盖第一份——用户看到的是"我的上一份主题怎么自己变了"。
 *
 * id 因此改为名称的稳定哈希（ASCII、不随语言退化、段长合规），人类可读的名字继续留在
 * `pkg.name`（manifest 只限制 1..60 字符，允许中文）。撞号时一律加 `-2/-3` 后缀新建，
 * 只有 **id 与 name 同时相同**才认定为"同一份主题再存一次"，允许原地升版。
 */

/** FNV-1a 32 位散列（确定性、无依赖、对短字符串足够均匀） */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** 名称 → 短标识（base36，小写字母数字，最长 7 位；空名给稳定兜底值） */
export function shortHash(name: string): string {
  const key = name.trim().toLowerCase();
  if (!key) return "unnamed";
  return fnv1a(key).toString(36).slice(0, 7);
}

/**
 * Agent 产物 id：`<前缀>-<名称哈希>`。
 * 前缀约定 `user.agent.theme` / `user.agent`，与 pluginManifest 的 ID_RE 同形
 * （每段 ≤32 字符、小写字母数字与 -_、至少两段）。
 */
export function agentPluginId(prefix: string, name: string): string {
  return `${prefix}-${shortHash(name)}`;
}

/** 撞号时找空位：base → base-2 → base-3 …（绝不覆盖既有插件） */
export function freeAgentId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * 「是不是同一份东西再存一次」的判据：id 相同**且**名字相同。
 * 只满足 id 相同 = 哈希撞车或改名前缀巧合，必须另立门户而不是覆盖。
 */
export function isSameAgentArtifact(
  existing: { id: string; name: string } | undefined,
  prefix: string,
  name: string,
): boolean {
  if (!existing) return false;
  return existing.id === agentPluginId(prefix, name) && existing.name.trim() === name.trim();
}
