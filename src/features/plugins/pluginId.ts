/**
 * 已搬迁：实现现在在 `src/features/artifact/id.ts`（AI 产物的身份规则不属于旧插件系统）。
 * 这里只留 re-export，等旧壳整批删除时一起删掉。
 */
export { fnv1a, shortHash, agentPluginId, freeAgentId, isSameAgentArtifact } from "../artifact/id";
