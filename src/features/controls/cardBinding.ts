/**
 * P121-D3/#103 · 卡面上那行「我绑的是谁」。
 *
 * 「生成控件」在 TX组帧台那边点一下就在控制画布落了一张滑条卡，可卡面只有名字和量程 ——
 * 拖动它到底在改哪张谱的哪个参数，画布上看不出来；那张谱的参数被删了也看不出来。
 * 单独抽成一个函数就为了能把这五种状态逐个钉住：界面上它们都只有一行小字，
 * 说错一种就是"用户以为还在绑，其实早就断了"。
 */
import { tx } from "../../i18n/strings";

export interface BindingCard {
  sendTemplateId?: string;
  paramId?: string;
}

export interface BindingSpec {
  name: string;
  params: { id: string; name: string }[];
  /** 谱里的块：查这个参数被哪一块真正带走（`SendField` 结构上可直接传进来） */
  fields?: { name: string; source?: { kind: string; paramId?: string } }[];
}

/** 空串 = 这张卡不是引用式的，卡面什么都不该多写 */
export function bindingLabel(card: BindingCard, spec: BindingSpec | null | undefined): string {
  if (!card.sendTemplateId) return "";
  if (!spec) return tx("引用的谱已删除", "template deleted");
  if (!card.paramId) {
    return tx(`绑「${spec.name}」（没选参数）`, `bound to “${spec.name}” (no parameter)`);
  }
  const p = spec.params.find((x) => x.id === card.paramId);
  if (!p) return tx(`绑「${spec.name}」（参数已删除）`, `bound to “${spec.name}” (parameter deleted)`);
  return tx(`绑「${spec.name}」› ${p.name}`, `bound to “${spec.name}” › ${p.name}`);
}

/** 反向：一张谱的一个参数，在控制画布上被哪些卡用着（P122-C 的字段→控件定位） */
export interface RevealCard {
  id: string;
  name: string;
  sendTemplateId?: string;
  paramId?: string;
}

export interface RevealPage {
  id: string;
  name: string;
  cards: RevealCard[];
}

export interface RevealHit {
  cardId: string;
  cardName: string;
  pageId: string;
  pageName: string;
  /** 这张卡就在当前页上 ⇒ 能当场闪一下；否则得先让人决定要不要切过去 */
  onActivePage: boolean;
}

/**
 * 只认 `sendTemplateId + paramId` 这一对引用式绑定。
 *
 * `managed.paramId` 是惯导预设的另一套 id 空间，拿同一个数来认就把两个不相干的东西
 * 说成"绑着"了 —— 所以这里刻意不看它。多张卡共用一个参数是合法状态，全部列出来。
 */
export function revealTargets(
  specId: string,
  paramId: string,
  pages: RevealPage[],
  activePageId: string,
): RevealHit[] {
  if (!specId || !paramId) return [];
  const out: RevealHit[] = [];
  for (const p of pages) {
    for (const c of p.cards) {
      if (c.sendTemplateId !== specId || c.paramId !== paramId) continue;
      out.push({
        cardId: c.id,
        cardName: c.name,
        pageId: p.id,
        pageName: p.name,
        onActivePage: p.id === activePageId,
      });
    }
  }
  return out;
}

/**
 * 悬浮展开的那一句：值最终落在**哪一帧的哪一块**。
 *
 * 卡面上写不完"哪个协议的哪个字段"，但这句话必须问得到 —— 尤其是最后那种：
 * 参数选了、谱里却没有一块引用它，这张卡拖得再欢，发出去的字节一个都不动。
 * 那是配置错了，得让它自己说出来，而不是让人以为接好了。
 */
export function bindingDetail(card: BindingCard, spec: BindingSpec | null | undefined): string {
  if (!card.sendTemplateId) return "";
  if (!spec) {
    return tx(
      "引用的发送谱已删除：发的时候会点名报错，不会静默发旧字节",
      "The referenced template is gone: sending names the error instead of quietly sending stale bytes",
    );
  }
  if (!card.paramId) {
    return tx(`发「${spec.name}」，但没选参数：拖动这张卡不改变任何字节`, `sends “${spec.name}” with no parameter — moving it changes nothing`);
  }
  const p = spec.params.find((x) => x.id === card.paramId);
  if (!p) return tx(`「${spec.name}」里没有这个参数了（被删或换了 id）`, `“${spec.name}” no longer has that parameter`);
  const users = (spec.fields ?? []).filter((f) => f.source?.kind === "param" && f.source.paramId === p.id);
  if (!users.length) {
    return tx(
      `值灌进「${spec.name}」的参数「${p.name}」—— 但谱里没有一块引用它，发出去的字节不会因此改变`,
      `value feeds parameter “${p.name}” of “${spec.name}” — but no block references it, so the bytes on the wire do not change`,
    );
  }
  const names = users.map((f) => `「${f.name}」`).join("、");
  return tx(
    `值灌进「${spec.name}」的参数「${p.name}」，落在块 ${names}`,
    `value feeds parameter “${p.name}” of “${spec.name}”, landing in block ${names}`,
  );
}
