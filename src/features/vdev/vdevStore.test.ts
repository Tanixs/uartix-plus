import { describe, expect, it } from "vitest";
import { builtinSpecs, buildTemplateImport, getSnapshot, loadEditing, normalizeSpec, removeFromLibrary, saveEditing, setEditing } from "./vdevStore";

describe("vdevStore normalizeSpec（P78c/P79）", () => {
  it("内置设备全部合法且 normalize 幂等", () => {
    for (const b of builtinSpecs()) {
      const n = normalizeSpec(b);
      expect(n.name).toBe(b.name);
      const again = normalizeSpec(n);
      expect(JSON.stringify(again)).toBe(JSON.stringify(n));
    }
  });

  it("net 段缺省 = 不写（旧设备 JSON 行为不变）", () => {
    const noNet = { name: "x", frame: { fields: [{ signal: "a", type: "uint8" }] }, signals: [{ name: "a", model: "const", value: 0 }] };
    expect(normalizeSpec(noNet).net).toBeUndefined();
  });

  it("net 校验：非法 transport / tcp-server bind 白名单 / udp 自环端口", () => {
    const base = { name: "x", frame: { fields: [{ signal: "a", type: "uint8" }] }, signals: [{ name: "a", model: "const", value: 0 }] };
    expect(() => normalizeSpec({ ...base, net: { transport: "pigeon" } })).toThrow(/不支持的网络链路类型/);
    expect(() => normalizeSpec({ ...base, net: { transport: "tcp-server", bind: "0.0.0.1", port: 9 } })).toThrow(/监听地址仅支持/);
    expect(() => normalizeSpec({ ...base, net: { transport: "udp", host: "127.0.0.1", port: 9, listenPort: 9 } })).toThrow(/不能相同/);
    expect(() => normalizeSpec({ ...base, net: { transport: "serial", path: "" } })).toThrow(/端口路径/);
    const ok = normalizeSpec({ ...base, net: { transport: "tcp-server", bind: "0.0.0.0", port: 9000 } });
    expect(ok.net?.bind).toBe("0.0.0.0");
  });

  it("buildTemplateImport：定长 = header+字段+checksum，scale/校验映射正确", () => {
    const furnace = builtinSpecs().find((b) => b.name === "温控炉")!;
    const t = buildTemplateImport(furnace) as unknown as {
      group: string;
      templates: { boundary: { fixedLength: number; headerBytes: number[] }; checksum: { algo: string; coverageEnd: number }; fields: { name: string; scale?: number }[] }[];
    };
    expect(t.group).toContain("虚拟设备");
    const tpl = t.templates[0];
    // TM(2) + int16(2) + uint8(1) + sum8(1) = 6
    expect(tpl.boundary.fixedLength).toBe(6);
    expect(tpl.boundary.headerBytes).toEqual([0x54, 0x4d]);
    expect(tpl.checksum.algo).toBe("sum8");
    expect(tpl.checksum.coverageEnd).toBe(-1);
    expect(tpl.fields[0].scale).toBe(0.1);
    expect(tpl.fields[1].scale).toBeUndefined(); // scale=1 不写（保持原始值）
  });

describe("设备库保存闭环（P80-1）", () => {
  const base = () => normalizeSpec({ name: "测试机", frame: { fields: [{ signal: "a", type: "uint8" }] }, signals: [{ name: "a", model: "const", value: 1 }] });

  it("新建 = 未保存态；保存入库、再保存不产生重复条目（含改名原位更新）", () => {
    const spec = base();
    loadEditing(spec, null);
    expect(getSnapshot().dirty).toBe(true);
    expect(getSnapshot().editingId).toBeNull();
    const name = saveEditing();
    expect(name).toBe("测试机");
    expect(getSnapshot().dirty).toBe(false);
    const id = getSnapshot().editingId!;
    expect(getSnapshot().specs.some((x) => x.id === id && x.spec.name === "测试机")).toBe(true);
    // 改名后再保存：同一 id 原位更新，库里不出现两条
    setEditing({ ...getSnapshot().editing!, name: "测试机改" });
    expect(getSnapshot().dirty).toBe(true);
    saveEditing();
    const snap = getSnapshot();
    expect(snap.editingId).toBe(id);
    expect(snap.specs.filter((x) => x.id === id)).toHaveLength(1);
    expect(snap.specs.find((x) => x.id === id)!.spec.name).toBe("测试机改");
    expect(snap.dirty).toBe(false);
    removeFromLibrary(id);
  });

  it("载入库条目 = 已保存态；编辑后变脏；非法内容保存报错且编辑不丢", () => {
    const id = saveEditing() ? "x" : "x"; // 先确保函数可用
    void id;
    const spec = base();
    loadEditing(spec, null);
    saveEditing();
    const saved = getSnapshot().specs.find((x) => x.spec.name === "测试机")!;
    loadEditing(structuredClone(saved.spec), saved.id);
    expect(getSnapshot().dirty).toBe(false);
    setEditing({ ...getSnapshot().editing!, periodMs: 99999 });
    expect(getSnapshot().dirty).toBe(true);
    // 非法：设备名清空
    setEditing({ ...getSnapshot().editing!, name: " " });
    expect(saveEditing()).toBeNull();
    expect(getSnapshot().err).toBeTruthy();
    expect(getSnapshot().editing!.name).toBe(" "); // 编辑内容保留
    removeFromLibrary(saved.id);
  });
});
});
