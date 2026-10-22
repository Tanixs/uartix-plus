/**
 * P174-A6：安装的**判据**（纯函数，一行 IO 都没有）。
 *
 * 装一个插件的流程是：选目录 → 校验 → 要不要批准 → 复制到暂存 → 再校验 → 提升 → 写账本。
 * 这里面真正会出错、而且**错了会静默**的部分全在这里：
 *
 * - 权限摘要怎么算（算宽了 ⇒ 改描述也要重批；算窄了 ⇒ 加了写目录却不重批）
 * - 批准之后写进信任库的到底是什么（是"用户看到的那些行"，不是一串哈希）
 * - 卸载时到底该摘掉哪几样（漏一样就是"删了但还显示在列表里"）
 *
 * IO 与命令调用在 `extStore.ts`。这样分的理由和 A3 一样：`invoke` 在 vitest 里跑不起来，
 * 判据放进去等于没测。
 */

import type { ExtensionManifest } from "./manifest";
import {
  extDir,
  permissionDelta,
  flattenPermissions,
  removeFromIndex,
  REPO_VERSION,
  stagingDir,
  trustDigestInput,
  trustVerdict,
  upsertIndex,
  type ExtIndex,
  type ExtIndexItem,
  type PermissionDelta,
  type TrustBook,
  type TrustVerdict,
} from "./repo";

/**
 * 权限指纹 = **那份规范串本身**，不是它的哈希。
 *
 * 为什么不做哈希：哈希的唯一作用是把长串变短，代价是把"权限变了"变成"看起来没变"
 * （碰撞）。而这份串只有几百字节，存进 `trust.json` 完全无所谓；更值的是它**可读**——
 * 出问题时打开信任库就能看见"用户当初批的是哪一份权限面"，不用反推一个摘要。
 *
 * 规范化的责任在 `trustDigestInput`（键排序、数组排序、不含 name/description），
 * 那是 A2 已经钉住的东西，这里不重复实现。
 */
export function fingerprintOf(m: ExtensionManifest): string {
  return trustDigestInput(m);
}

export interface InstallPlan {
  /** 用户选的源目录（只读，装完就不再碰它）。 */
  srcDir: string;
  id: string;
  name: string;
  version: string;
  manifest: ExtensionManifest;
  fingerprint: string;
  /** 这次要向用户说明的权限行（`flattenPermissions` 的输出，人能读的那种）。 */
  permissions: string[];
  verdict: TrustVerdict;
  /** 与"上次批准的那一份"相比新增/移除了什么；`needs-approval` 时两者都空。 */
  delta: PermissionDelta;
  /** 上次批准时列出的行（`changed` 时要把"你上次批的是这些"摆出来）。 */
  previous: string[];
  draftId: string;
  stagingPath: string;
  finalDir: string;
}

export function needsApproval(p: Pick<InstallPlan, "verdict">): boolean {
  return p.verdict !== "trusted";
}

export interface PlanInput {
  appDir: string;
  srcDir: string;
  manifest: ExtensionManifest;
  trust: TrustBook;
  /** 暂存目录名。由调用方给（纯函数里不许有随机/时间），测试里给固定值。 */
  draftId: string;
}

export function planInstall(input: PlanInput): InstallPlan {
  const { appDir, srcDir, manifest, trust, draftId } = input;
  const fingerprint = fingerprintOf(manifest);
  const prev = trust.items[manifest.id];
  const verdict = trustVerdict(prev, fingerprint);
  const permissions = flattenPermissions(manifest);
  const previous = prev?.grantedSummary ?? [];
  return {
    srcDir,
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    manifest,
    fingerprint,
    permissions,
    verdict,
    // 第一次装时"新增了什么"等于"要什么"，但批准卡上不该把两者混着说——
    // 所以 delta 只在 changed 时有意义，needs-approval 时留空，界面据此换一种说法。
    delta: verdict === "changed" ? permissionDelta(previous, permissions) : { added: [], removed: [] },
    previous,
    draftId,
    stagingPath: stagingDir(appDir, draftId),
    finalDir: extDir(appDir, manifest.id),
  };
}

export interface ApplyInput {
  approvedAt: number;
  source: ExtIndexItem["source"];
}

/**
 * 把一次已完成的安装写进两本账。
 *
 * 关键：**`trusted` 时不写信任库**。信任库记的是"用户批准过哪一份权限面"，
 * 内容没变却重写一遍，等于把 `grantedAt` 悄悄改成今天——之后用户问"我什么时候批的"
 * 就得到一个假答案。
 */
export function applyInstall(
  index: ExtIndex,
  trust: TrustBook,
  plan: InstallPlan,
  { approvedAt, source }: ApplyInput,
): { index: ExtIndex; trust: TrustBook } {
  const item: ExtIndexItem = {
    dir: plan.id,
    version: plan.version,
    digest: plan.fingerprint,
    installedAt: approvedAt,
    source,
  };
  const nextIndex = upsertIndex(index, plan.id, item);
  if (!needsApproval(plan)) return { index: nextIndex, trust };
  const nextTrust: TrustBook = {
    version: REPO_VERSION,
    items: {
      ...trust.items,
      [plan.id]: {
        id: plan.id,
        version: plan.version,
        digest: plan.fingerprint,
        grantedAt: approvedAt,
        // 存"用户看到的那几行"，不是重新算一遍：批准卡上写的是什么，账上就是什么。
        // 中间换了措辞就等于偷偷改了证据。
        grantedSummary: plan.permissions,
      },
    },
  };
  return { index: nextIndex, trust: nextTrust };
}

/** 卸载：两本账一起摘。只摘一边的后果是"删了却还在列表里"或"重装不弹批准"。 */
export function applyUninstall(
  index: ExtIndex,
  trust: TrustBook,
  id: string,
): { index: ExtIndex; trust: TrustBook } {
  const items = { ...trust.items };
  delete items[id];
  return {
    index: removeFromIndex(index, id),
    trust: { version: REPO_VERSION, items },
  };
}
