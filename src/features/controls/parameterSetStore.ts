export const PARAMETER_SET_SCHEMA = "vs-parameter-set/v1" as const;
export const PARAMETER_SET_STORAGE_KEY = "vs.controls.parameterSets.v1";
export const MAX_PARAMETER_SET_IMPORT_BYTES = 1024 * 1024;

export interface ParameterSetEntry {
  readonly paramId: string;
  readonly value: number;
  readonly source: "requested" | "observed";
  readonly observedAt?: number;
}

export interface ParameterSet {
  readonly schema: typeof PARAMETER_SET_SCHEMA;
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly createdAt: number;
  readonly profileId: string;
  readonly profileVersion: number;
  /** Array order is the saved parameter order; this store never executes it. */
  readonly entries: readonly ParameterSetEntry[];
}

export type SaveParameterSetInput = Omit<ParameterSet, "schema" | "id" | "version" | "createdAt"> & {
  /** Base revision, not an identity to overwrite. The saved revision is greater. */
  readonly version?: number;
};

export interface ParameterSetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ParameterSetStoreOptions {
  now?: () => number;
  createId?: () => string;
}

function invalid(field: string): never {
  throw new Error(`Invalid parameter set: ${field}.`);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid("expected an object");
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() ||
      value.length > max) invalid(field);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) invalid(field);
  }
  return value;
}

function revision(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(field);
  return value;
}

function timestamp(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) invalid(field);
  return value;
}

/** Pure validation and whitelist projection. Unknown fields are never copied. */
export function parseParameterSet(value: unknown): ParameterSet {
  const raw = record(value);
  if (raw.schema !== PARAMETER_SET_SCHEMA) invalid("unsupported schema");
  const id = text(raw.id, "id", 128);
  const name = text(raw.name, "name (1–64 characters)", 64);
  const version = revision(raw.version, "version");
  const createdAt = timestamp(raw.createdAt, "createdAt");
  const profileId = text(raw.profileId, "profileId", 128);
  const profileVersion = revision(raw.profileVersion, "profileVersion");
  if (!Array.isArray(raw.entries) || raw.entries.length > 32) invalid("entries (at most 32)");
  const seen = new Set<string>();
  const entries: ParameterSetEntry[] = [];
  for (const value of raw.entries) {
    const entry = record(value);
    const paramId = text(entry.paramId, "paramId", 128);
    if (seen.has(paramId)) invalid("duplicate paramId");
    seen.add(paramId);
    if (typeof entry.value !== "number" || !Number.isFinite(entry.value)) invalid("finite entry value required");
    if (entry.source !== "requested" && entry.source !== "observed") invalid("entry source");
    const projected: ParameterSetEntry = entry.observedAt === undefined
      ? { paramId, value: entry.value, source: entry.source }
      : { paramId, value: entry.value, source: entry.source, observedAt: timestamp(entry.observedAt, "observedAt") };
    entries.push(Object.freeze(projected));
  }
  return Object.freeze({ schema: PARAMETER_SET_SCHEMA, id, name, version, createdAt,
    profileId, profileVersion, entries: Object.freeze(entries) });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Invalid parameter set JSON.");
  }
}

const browserStorage: ParameterSetStorage = {
  getItem: (key) => globalThis.localStorage.getItem(key),
  setItem: (key, value) => globalThis.localStorage.setItem(key, value),
};

/** Lazy loading keeps module import side-effect free, including outside a browser. */
export class ParameterSetStore {
  private snapshot: readonly ParameterSet[] = Object.freeze([]);
  private loaded = false;
  private persisted: string | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(private readonly storage: ParameterSetStorage = browserStorage, options: ParameterSetStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => globalThis.crypto.randomUUID());
  }

  private readStorage(): string | null {
    try {
      return this.storage.getItem(PARAMETER_SET_STORAGE_KEY);
    } catch {
      throw new Error("Unable to read parameter set storage; nothing was changed.");
    }
  }

  private load(): void {
    if (this.loaded) return;
    const stored = this.readStorage();
    let sets: ParameterSet[] = [];
    if (stored !== null) {
      try {
        const raw = parseJson(stored);
        if (!Array.isArray(raw) || raw.length > 50) invalid("stored sets (at most 50)");
        sets = raw.map(parseParameterSet);
        if (new Set(sets.map((set) => set.id)).size !== sets.length) invalid("duplicate set id");
      } catch {
        throw new Error("Stored parameter sets are corrupt or incompatible. Nothing was changed; explicitly repair or remove the stored value before retrying.");
      }
    }
    this.snapshot = Object.freeze(sets);
    this.persisted = stored;
    this.loaded = true;
  }

  list = (): readonly ParameterSet[] => {
    this.load();
    return this.snapshot;
  };

  getSnapshot = (): readonly ParameterSet[] => this.list();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  saveParameterSet = (input: SaveParameterSetInput): ParameterSet => this.save(input);

  private save(input: SaveParameterSetInput, importedId?: string): ParameterSet {
    this.load();
    const raw = record(input);
    const baseVersion = raw.version === undefined ? 0 : revision(raw.version, "version");
    const latest = this.snapshot.reduce((max, set) =>
      set.profileId === raw.profileId && set.name === raw.name ? Math.max(max, set.version) : max, baseVersion);
    // Validate before generating identity or touching persistence; never spread untrusted input.
    const candidate = parseParameterSet({
      schema: PARAMETER_SET_SCHEMA, id: "pending", name: raw.name,
      version: latest + 1, createdAt: this.now(), profileId: raw.profileId,
      profileVersion: raw.profileVersion, entries: raw.entries,
    });
    if (this.snapshot.length >= 50) throw new Error("Parameter set limit reached (50); nothing was changed.");
    let id = "";
    for (let attempt = 0; attempt < 10; attempt++) {
      id = text(this.createId(), "generated id", 128);
      if (id !== importedId && !this.snapshot.some((set) => set.id === id)) break;
      id = "";
    }
    if (!id) throw new Error("Unable to create a unique parameter set id; nothing was changed.");
    const saved = parseParameterSet({
      schema: candidate.schema, id, name: candidate.name, version: candidate.version,
      createdAt: candidate.createdAt, profileId: candidate.profileId,
      profileVersion: candidate.profileVersion, entries: candidate.entries,
    });
    const next = Object.freeze([...this.snapshot, saved]);
    // Do not overwrite changes (including corruption) made by another tab/store.
    if (this.readStorage() !== this.persisted) {
      throw new Error("Parameter set storage changed; reload the store before saving. Nothing was changed.");
    }
    const serialized = JSON.stringify(next);
    try {
      this.storage.setItem(PARAMETER_SET_STORAGE_KEY, serialized);
    } catch {
      throw new Error("Unable to save parameter sets; nothing was changed.");
    }
    this.persisted = serialized;
    this.snapshot = next;
    for (const listener of Array.from(this.listeners)) {
      // A subscriber failure must not turn an already committed save into a reported failure.
      try { listener(); } catch { /* Other subscribers must still be notified. */ }
    }
    return saved;
  }

  importParameterSet = (text: string): ParameterSet => {
    if (typeof text !== "string" || text.length > MAX_PARAMETER_SET_IMPORT_BYTES ||
        new TextEncoder().encode(text).byteLength > MAX_PARAMETER_SET_IMPORT_BYTES) {
      throw new Error("Parameter set import exceeds the 1 MiB limit or is not text.");
    }
    const parsed = parseParameterSet(parseJson(text));
    return this.save({ name: parsed.name, version: parsed.version, profileId: parsed.profileId,
      profileVersion: parsed.profileVersion, entries: parsed.entries }, parsed.id);
  };

  exportParameterSet = (id: string): string => {
    const set = this.list().find((set) => set.id === id);
    if (!set) throw new Error("Parameter set not found.");
    return JSON.stringify(parseParameterSet(set), null, 2);
  };
}

export const parameterSetStore = new ParameterSetStore();
export const list = parameterSetStore.list;
export const getSnapshot = parameterSetStore.getSnapshot;
export const subscribe = parameterSetStore.subscribe;
export const saveParameterSet = parameterSetStore.saveParameterSet;
export const importParameterSet = parameterSetStore.importParameterSet;
export const exportParameterSet = parameterSetStore.exportParameterSet;
