/**
 * P174-A18②：**AI 产物的身份规则**（纯函数，零依赖）。
 *
 * 从 `plugins/pluginId.ts` 搬过来。搬的理由不是"换个目录好看"，而是这份规则**不属于旧插件系统**：
 * 它讲的是"AI 造出来的东西怎么拿 id"，而旧插件系统这一批就要删掉了，AI 造物的能力要留下。
 *
 * 为什么不按名字 slug：旧实现 `name.toLowerCase().replace(/[^a-z0-9]+/g,"-")` 会把中文整个吃掉，
 * 「AI 助手现代玻璃风」→ `user.agent.theme-ai`，纯中文名一律退化成同一个 id。两份**不同**的中文主题
 * 因此会撞成同一个 id，而"同 id 即原地升版"的策略会让第二份静默覆盖第一份——
 * 用户看到的是"我上一份主题怎么自己变了"。
 *
 * 所以 id 用名称的稳定哈希（ASCII、不随语言退化、段长合规），人类可读的名字留在 `name` 里。
 * 撞号一律加 `-2/-3` 新建；只有 **id 与 name 同时相同**才算"同一份再存一次"。
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
 * 前缀约定 `user.agent.theme` / `user.agent`（每段 ≤32 字符、小写字母数字与 -_、至少两段）。
 */
export function agentPluginId(prefix: string, name: string): string {
  return `${prefix}-${shortHash(name)}`;
}

/** 撞号时找空位：base → base-2 → base-3 …（绝不覆盖既有产物） */
export function freeAgentId(base: string, taken: (id: string) => boolean): string {
  if (!taken(base)) return base;
  let n = 2;
  while (taken(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * 「是不是同一份东西再存一次」：id 相同**且**名字相同。
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
