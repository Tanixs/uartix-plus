/**
 * P121-E · 收到的一帧 → 草稿发送谱（把 `inferSpec` 接到真实数据源上的那层薄皮）。
 *
 * 之所以要有这一层：反推本身只认字节，而"这一帧是谁家的、哪段是什么"住在接收侧的模板里。
 * 拿着 tplId 去要字段边界，草稿才能长成有名字的块；要不到就退回一段定长字节 ——
 * 那时它照样能原样发回去，只是不好改。
 */
import * as templateStore from "../protocol/templateStore";
import type { InferField, InferResult } from "./inferSpec";
import { inferSendSpec } from "./inferSpec";

/** 那张接收模板的字段边界，换算成"相对这一帧"的偏移（负偏移就是贴尾算出来的） */
export function layoutOf(tplId: string | undefined, frameLen: number): InferField[] | undefined {
  if (!tplId) return undefined;
  const tpl = templateStore
    .getSnapshot()
    .rules.templates.find((t) => t.id === tplId);
  if (!tpl?.fields.length) return undefined;
  return tpl.fields.map((f) => ({
    name: f.name,
    role: f.role,
    offset: f.offset < 0 ? frameLen + f.offset : f.offset,
    size: templateStore.fieldSize(f),
    endian: f.endian,
  }));
}

export function draftFromFrame(bytes: number[], tplId?: string, name?: string): InferResult {
  const r = inferSendSpec(bytes, { name, fields: layoutOf(tplId, bytes.length) });
  // P122-B 来处标注：认得出这一帧属于哪个协议就记下 id（只存 id，名字渲染时查）
  return tplId ? { ...r, tpl: { ...r.tpl, fromTplId: tplId } } : r;
}
