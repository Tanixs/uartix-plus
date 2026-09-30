/**
 * P121-E · 「收到的一帧 → 草稿谱」这一层皮（#102）。
 *
 * 反推本体在 `inferSpec.test.ts` 里钉；这里钉的是**跨面板那一段**：
 * 拿着接收模板的 id 去要字段边界时，负偏移（贴尾锚定）要换算成这一帧里的正偏移，
 * 要不到模板就安静退回定长字节 —— 这条链一旦接错，草稿就会切错块名或干脆崩在按钮上。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../ipc/framesBus", () => ({ onFrames: () => () => undefined }));
vi.mock("../settings/settingsStore", () => ({
  getSnapshot: () => ({ theme: "dark", locale: "zh", zoom: 100, palette: "okabe", channels: [] }),
  subscribe: () => () => {},
  patch: () => undefined,
}));
vi.mock("../../panels/panelActivity", () => ({
  isOpen: () => false,
  markOpen: () => undefined,
  markClose: () => undefined,
  subscribe: () => () => {},
}));

import * as templateStore from "../protocol/templateStore";
import type { FrameTemplate } from "../../ipc/types";
import { encodeSend } from "./encodeSend";
import { draftFromFrame, layoutOf } from "./fromFrame";

beforeEach(() => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  vi.useFakeTimers();
  templateStore.replaceRules([]);
});

function seedTpl(checksum: FrameTemplate["checksum"]) {
  templateStore.replaceRules([
    {
      id: "rx1",
      name: "接收模板",
      color: "#fff",
      enabled: true,
      boundary: { mode: "fixedLength", headerBytes: [0xaa], maxLength: 16, fixedLength: 6 },
      checksum,
      fields: [
        { id: "h", name: "帧头", role: "header", offset: 0, type: "uint8", endian: "big", color: "#888" },
        { id: "d", name: "数值", role: "data", offset: 1, type: "uint16", endian: "big", color: "#888" },
        // 贴尾锚定：偏移是负数，换算到"这一帧的第几个字节"才是它真正占的位置
        { id: "t", name: "帧尾", role: "footer", offset: -1, type: "uint8", endian: "big", color: "#888" },
      ],
    } as FrameTemplate,
  ]);
}

describe("P121-E · layoutOf", () => {
  it("负偏移换算成这一帧里的正偏移，宽度按字段类型算", () => {
    seedTpl(null);
    const f = layoutOf("rx1", 6)!;
    expect(f.map((x) => [x.name, x.offset, x.size])).toEqual([
      ["帧头", 0, 1],
      ["数值", 1, 2],
      ["帧尾", 5, 1],
    ]);
  });

  it("没有这张模板就交不出边界（调用处会退回定长字节，而不是报错）", () => {
    seedTpl(null);
    expect(layoutOf("nope", 6)).toBeUndefined();
    expect(layoutOf(undefined, 6)).toBeUndefined();
  });
});

describe("P121-E · draftFromFrame", () => {
  it("带模板边界时，草稿的块名就是字段名，且编回去还是这一帧", () => {
    seedTpl(null);
    const bytes = [0xaa, 0x12, 0x34, 0x00, 0x00, 0x55];
    const r = draftFromFrame(bytes, "rx1", "照帧起的谱");
    expect(r.tpl.fields.map((f) => f.name)).toEqual(["帧头", "数值", "未覆盖3", "帧尾"]);
    expect(encodeSend(r.tpl, { seq: r.tpl.nextSeq }).hex).toBe("AA 12 34 00 00 55");
  });

  it("认得出校验段时，模板里那块「校验」不会与算法各写一份", () => {
    seedTpl(null);
    // 6 字节帧：aa | 12 34 | 末字节 = sum8(12 34)=0x46 —— 帧尾那块正好是校验域的位置
    const body = [0x12, 0x34];
    const bytes = [0xaa, ...body, (body[0] + body[1]) & 0xff];
    const r = draftFromFrame(bytes, "rx1", "带校验");
    expect(r.tpl.checksum?.algo, "尾巴是能重算出来的 sum8，草稿该带上校验").toBe("sum8");
    expect(r.tpl.fields.filter((f) => f.role === "checksum" || f.role === "checksum2")).toHaveLength(1);
    expect(encodeSend(r.tpl, { seq: r.tpl.nextSeq }).hex).toBe("AA 12 34 46");
  });
});
