/**
 * P105-F T3a：**界面用的**产物种类名 / 插件状态名 / contributions 键名。
 *
 * 为什么要这一层：名字住在 `artifact.ts` 的元表与 `pluginStore.ts` 的状态表里，而那是数据层 ——
 * 拿不到组件、也不能在求值期调 `tx()`（语言会被钉死在 import 那一刻）。
 * 所以表里存**中英两条**，到这里才按当前语言挑一条。就这一件事。
 *
 * ⚠ 一条被纠正过的判断，留在原地免得下一个人再犯：我最初把这说成
 * "同一个名字既上屏又出口给 CLI/模型，所以出口那份不能跟着语言动"。查过之后是错的 ——
 * CLI 有 `--json`（机器走结构），终端话术在 `scripts/plugin-cli-core.ts` 里自己写，
 * 模型侧的工具 schema 描述本来就是英文。出口不依赖这里的中文。
 * 真正的规矩是另一条：**给机器的带枚举/代码，给人看的才渲染名字**
 * （`marketCli` 的 `plugins_installed` 曾把中文状态名塞进 `--json` 字段，那是缺陷，已按这条改）。
 *
 * 本文件是"对人说"的层，所以它进 i18n 门的点名表（`.tools/i18n-scan.cjs` 的 `UI_TS`）：
 * 这里漏一句中文，界面上就是漏一句中文。
 */
import { ARTIFACT_KINDS, artifactKindMeta, kindOfContribKey } from "./artifact";
import type { ArtifactKind } from "./artifact";
import { PLUGIN_STATE_LABEL, PLUGIN_STATE_LABEL_EN } from "./pluginStore";
import type { PluginState } from "./pluginStore";
import { tx } from "../../i18n/strings";

/** 状态徽章：中文表与英文表同一组键（都是 `Record<PluginState,…>`，少一个编译不过），取哪一份只看当前语言 */
export function stateName(state: PluginState): string {
  return tx(PLUGIN_STATE_LABEL[state], PLUGIN_STATE_LABEL_EN[state]);
}

const metaOf = (kind: string): { label: string; labelEn: string } | null => {
  const k = (ARTIFACT_KINDS as readonly string[]).includes(kind) ? (kind as ArtifactKind) : null;
  return k ? artifactKindMeta(k) : null;
};

/**
 * 产物种类名。不在枚举里的（模型给的串、索引里新加的 kind）照原样回显 ——
 * 编一个"看起来对"的名字比承认不认识更坏（`artifactKindLabel` 同一条口径）。
 */
export function kindName(kind: string): string {
  const meta = metaOf(kind);
  return meta ? tx(meta.label, meta.labelEn) : kind;
}

/** contributions 的键（`themes`/`widgets`…）说人话：与种类名同源，不另立一份表 */
export function contribName(contribKey: string): string {
  const k = kindOfContribKey(contribKey);
  const meta = k ? artifactKindMeta(k) : null;
  return meta ? tx(meta.label, meta.labelEn) : contribKey;
}
