import { describe, expect, it, vi } from "vitest";
import {
  MAX_PARAMETER_SET_IMPORT_BYTES,
  PARAMETER_SET_SCHEMA,
  PARAMETER_SET_STORAGE_KEY,
  ParameterSetStore,
  parseParameterSet,
  type ParameterSetStorage,
  type SaveParameterSetInput,
} from "./parameterSetStore";

function input(): SaveParameterSetInput {
  return {
    name: "Calibration", profileId: "profile-1", profileVersion: 1,
    entries: [
      { paramId: "gain", value: 1.5, source: "requested" },
      { paramId: "offset", value: -2, source: "observed", observedAt: 100 },
    ],
  };
}

function fixture() {
  return { schema: PARAMETER_SET_SCHEMA, id: "original", version: 1, createdAt: 100, ...input() };
}

class MemoryStorage implements ParameterSetStorage {
  value: string | null = null;
  failRead = false;
  failWrite = false;
  getItem = vi.fn((key: string) => {
    expect(key).toBe(PARAMETER_SET_STORAGE_KEY);
    if (this.failRead) throw new Error("private read details");
    return this.value;
  });
  setItem = vi.fn((key: string, value: string) => {
    expect(key).toBe(PARAMETER_SET_STORAGE_KEY);
    if (this.failWrite) throw new Error("private quota details");
    this.value = value;
  });
}

function setup() {
  const storage = new MemoryStorage();
  let sequence = 0;
  const store = new ParameterSetStore(storage, { now: () => 200, createId: () => `new-${++sequence}` });
  return { storage, store };
}

describe("parseParameterSet", () => {
  it("projects only schema fields, retaining stable bindings and entry order", () => {
    const raw = fixture();
    const parsed = parseParameterSet({ ...raw, connection: { password: "secret" }, script: "send()",
      entries: raw.entries.map((entry) => ({ ...entry, port: "COM3", setVar: "gain" })) });
    expect(parsed).toEqual(raw);
    expect(parsed).not.toBe(raw);
    expect(parsed.entries.map((entry) => entry.paramId)).toEqual(["gain", "offset"]);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.entries)).toBe(true);
    expect(Object.isFrozen(parsed.entries[0])).toBe(true);
  });

  it.each([
    { schema: "vs-parameter-set/v2" }, { id: "" }, { id: " id " }, { name: "" },
    { name: "a".repeat(65) }, { name: "unsafe\nname" }, { profileId: "" },
    { version: 0 }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 },
    { profileVersion: "1" }, { profileVersion: 0 }, { createdAt: -1 }, { createdAt: Infinity },
    { entries: null }, { entries: [null] },
    { entries: [{ paramId: "", value: 1, source: "requested" }] },
    { entries: [{ paramId: "a", value: NaN, source: "requested" }] },
    { entries: [{ paramId: "a", value: Infinity, source: "requested" }] },
    { entries: [{ paramId: "a", value: "1", source: "requested" }] },
    { entries: [{ paramId: "a", value: 1, source: "device" }] },
    { entries: [{ paramId: "a", value: 1, source: "observed", observedAt: -1 }] },
    { entries: [{ paramId: "a", value: 1, source: "observed", observedAt: NaN }] },
    { entries: [{ paramId: "a", value: 1, source: "observed", observedAt: null }] },
  ])("rejects invalid fields %j", (patch) => {
    expect(() => parseParameterSet({ ...fixture(), ...patch })).toThrow("Invalid parameter set");
  });

  it("rejects non-objects, duplicate parameters, and more than 32 entries", () => {
    for (const value of [null, [], "text", 3]) expect(() => parseParameterSet(value)).toThrow();
    const entry = input().entries[0];
    expect(() => parseParameterSet({ ...fixture(), entries: [entry, entry] })).toThrow("duplicate paramId");
    const entries = Array.from({ length: 32 }, (_, n) => ({ ...entry, paramId: `p${n}` }));
    expect(parseParameterSet({ ...fixture(), entries, name: "a".repeat(64) }).entries).toHaveLength(32);
    expect(() => parseParameterSet({ ...fixture(), entries: [...entries, { ...entry, paramId: "p32" }] })).toThrow("at most 32");
  });

  it("allows optional observation time and finite zero values without inventing evidence", () => {
    const parsed = parseParameterSet({ ...fixture(), entries: [{ paramId: "zero", value: 0, source: "observed" }] });
    expect(parsed.entries[0]).toEqual({ paramId: "zero", value: 0, source: "observed" });
    expect(parseParameterSet({ ...fixture(), entries: [] }).entries).toEqual([]);
  });
});

describe("ParameterSetStore", () => {
  it("loads lazily and exposes a stable, immutable snapshot with unsubscribe", () => {
    const { store, storage } = setup();
    expect(storage.getItem).not.toHaveBeenCalled();
    const initial = store.getSnapshot();
    expect(store.list()).toBe(initial);
    expect(store.getSnapshot()).toBe(initial);
    const listener = vi.fn(() => {
      expect(JSON.parse(storage.value!)).toEqual(store.getSnapshot());
    });
    const unsubscribe = store.subscribe(listener);
    const saved = store.saveParameterSet(input());
    expect(store.getSnapshot()).not.toBe(initial);
    expect(store.list()[0]).toBe(saved);
    expect(Object.isFrozen(store.list())).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    store.saveParameterSet(input());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("appends fresh identities and revisions, never overwriting old versions", () => {
    const { store, storage } = setup();
    const first = store.saveParameterSet(input());
    const second = store.saveParameterSet(input());
    const third = store.saveParameterSet({ ...input(), version: 10 });
    expect([first.version, second.version, third.version]).toEqual([1, 2, 11]);
    expect(new Set(store.list().map((set) => set.id)).size).toBe(3);
    expect(first.createdAt).toBe(200);
    expect(store.list()[0]).toBe(first);
    expect(store.saveParameterSet({ ...input(), profileId: "another" }).version).toBe(1);
    const restored = new ParameterSetStore(storage);
    expect(restored.list()).toEqual(store.list());
    expect(restored.getSnapshot()).toBe(restored.list());
  });

  it("ignores caller identity and connection fields and detaches mutable inputs", () => {
    const { store } = setup();
    const entries = [{ paramId: "gain", value: 1, source: "requested" as const, password: "secret" }];
    const saved = store.saveParameterSet({ ...input(), entries, id: "injected", createdAt: 1,
      schema: "other", port: "COM1" } as SaveParameterSetInput);
    entries[0].value = 999;
    expect(saved.entries[0].value).toBe(1);
    expect(JSON.parse(store.exportParameterSet(saved.id))).toEqual({ ...fixture(), id: saved.id,
      createdAt: 200, entries: [{ paramId: "gain", value: 1, source: "requested" }] });
    expect(() => store.exportParameterSet("missing")).toThrow("Parameter set not found");
  });

  it("keeps state, persistence, and notifications unchanged on write failure, then retries", () => {
    const { store, storage } = setup();
    store.saveParameterSet(input());
    const before = store.getSnapshot();
    const persisted = storage.value;
    const listener = vi.fn();
    store.subscribe(listener);
    storage.failWrite = true;
    expect(() => store.saveParameterSet(input())).toThrow("Unable to save parameter sets; nothing was changed.");
    expect(store.getSnapshot()).toBe(before);
    expect(storage.value).toBe(persisted);
    expect(listener).not.toHaveBeenCalled();
    storage.failWrite = false;
    expect(store.saveParameterSet(input()).version).toBe(2);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("validates saves without persisting, including revision overflow", () => {
    const { store, storage } = setup();
    const snapshot = store.getSnapshot();
    for (const patch of [{ name: "" }, { version: 0 }, { version: Number.MAX_SAFE_INTEGER }, { entries: [null] }]) {
      expect(() => store.saveParameterSet({ ...input(), ...patch } as SaveParameterSetInput)).toThrow();
    }
    expect(store.getSnapshot()).toBe(snapshot);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("rejects a 51st set without eviction", () => {
    const { store, storage } = setup();
    for (let i = 0; i < 50; i++) store.saveParameterSet(input());
    const snapshot = store.getSnapshot();
    const persisted = storage.value;
    expect(() => store.saveParameterSet(input())).toThrow("limit reached (50)");
    expect(() => store.importParameterSet(JSON.stringify(fixture()))).toThrow("limit reached (50)");
    expect(store.getSnapshot()).toBe(snapshot);
    expect(storage.value).toBe(persisted);
    expect(snapshot).toHaveLength(50);
  });

  it.each(["", "{bad private content", "null", "{}", JSON.stringify([{ ...fixture(), schema: "v2" }]),
    JSON.stringify([fixture(), fixture()]), JSON.stringify(Array.from({ length: 51 }, (_, n) => ({ ...fixture(), id: `s${n}` })))])(
    "preserves corrupt storage and blocks saves until explicit repair: %s", (value) => {
      const { store, storage } = setup();
      storage.value = value;
      expect(() => store.list()).toThrow("Stored parameter sets are corrupt or incompatible.");
      expect(() => store.saveParameterSet(input())).toThrow("explicitly repair or remove");
      expect(() => store.importParameterSet(JSON.stringify(fixture()))).toThrow("explicitly repair or remove");
      expect(storage.value).toBe(value);
      expect(storage.setItem).not.toHaveBeenCalled();
      storage.value = null; // Explicit resolution by the caller, never an automatic deletion.
      expect(store.saveParameterSet(input()).version).toBe(1);
    },
  );

  it("reports safe storage read errors without treating failure as empty storage", () => {
    const { store, storage } = setup();
    storage.failRead = true;
    expect(() => store.list()).toThrow("Unable to read parameter set storage; nothing was changed.");
    expect(() => store.saveParameterSet(input())).toThrow("Unable to read");
    expect(storage.setItem).not.toHaveBeenCalled();
    storage.failRead = false;
    expect(store.list()).toEqual([]);
  });

  it("does not overwrite externally changed or corrupted storage after loading", () => {
    const { store, storage } = setup();
    const snapshot = store.list();
    storage.value = "corrupted externally";
    expect(() => store.saveParameterSet(input())).toThrow("storage changed");
    expect(store.getSnapshot()).toBe(snapshot);
    expect(storage.value).toBe("corrupted externally");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("retries generated identity collisions, and fails without writes if exhausted", () => {
    const storage = new MemoryStorage();
    const createId = vi.fn().mockReturnValueOnce("original").mockReturnValueOnce("fresh").mockReturnValue("fresh");
    const store = new ParameterSetStore(storage, { now: () => 200, createId });
    expect(store.importParameterSet(JSON.stringify(fixture())).id).toBe("fresh");
    const before = store.list();
    expect(() => store.saveParameterSet(input())).toThrow("unique parameter set id");
    expect(store.list()).toBe(before);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("does not report a committed save as failed when a subscriber throws", () => {
    const { store } = setup();
    store.subscribe(() => { throw new Error("subscriber failure"); });
    const listener = vi.fn();
    store.subscribe(listener);
    expect(() => store.saveParameterSet(input())).not.toThrow();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.list()).toHaveLength(1);
  });
});

describe("JSON import and export", () => {
  it("validates imports and saves fresh identity, time, and version with a whitelist", () => {
    const { store } = setup();
    const text = JSON.stringify({ ...fixture(), host: "secret", approved: true,
      entries: [{ paramId: "gain", value: 5, source: "requested", script: "setVar()" }] });
    const first = store.importParameterSet(text);
    const second = store.importParameterSet(text);
    expect(first.id).not.toBe("original");
    expect(second.id).not.toBe(first.id);
    expect(first.createdAt).toBe(200);
    expect([first.version, second.version]).toEqual([2, 3]);
    const exported = store.exportParameterSet(first.id);
    expect(JSON.parse(exported)).toEqual(first);
    expect(exported).not.toMatch(/secret|approved|script|setVar/);
    const other = setup().store;
    expect(other.importParameterSet(exported).entries).toEqual(first.entries);
  });

  it("rejects malformed JSON, schema mismatch, invalid entries, and oversized UTF-8 without writes", () => {
    const { store, storage } = setup();
    const before = store.getSnapshot();
    const texts = ["{ private secret", "null", JSON.stringify({ ...fixture(), schema: "v0" }),
      JSON.stringify({ ...fixture(), entries: [{ paramId: "p", value: null, source: "observed" }] }),
      " ".repeat(MAX_PARAMETER_SET_IMPORT_BYTES + 1),
      JSON.stringify({ ...fixture(), ignored: "界".repeat(400_000) })];
    for (const text of texts) expect(() => store.importParameterSet(text)).toThrow();
    expect(() => store.importParameterSet("{ private secret")).toThrow("Invalid parameter set JSON.");
    expect(store.getSnapshot()).toBe(before);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("accepts exactly 1 MiB of valid JSON", () => {
    const { store } = setup();
    const text = JSON.stringify(fixture());
    expect(store.importParameterSet(text + " ".repeat(MAX_PARAMETER_SET_IMPORT_BYTES - text.length)).entries).toEqual(input().entries);
  });

  it("leaves imports transactional when persistence fails", () => {
    const { store, storage } = setup();
    const before = store.list();
    storage.failWrite = true;
    expect(() => store.importParameterSet(JSON.stringify(fixture()))).toThrow("Unable to save");
    expect(store.list()).toBe(before);
    expect(storage.value).toBeNull();
  });
});
