import type { UserCodecDef } from "./commandFactory";

const KEY = "vs.userCodecs";

function load(): { codecs: UserCodecDef[] } {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { codecs?: UserCodecDef[] };
      if (Array.isArray(parsed.codecs)) {
        return { codecs: parsed.codecs.filter((c) => c && c.id && c.name && Array.isArray(c.segs)) };
      }
    }
  } catch {
    localStorage.removeItem(KEY);
  }
  return { codecs: [] };
}

let snapshot: { codecs: UserCodecDef[] } = load();
const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  snapshot = { ...snapshot };
  listeners.forEach((l) => l());
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    localStorage.setItem(KEY, JSON.stringify(snapshot));
  }, 250);
}

export function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function getSnapshot() {
  return snapshot;
}

export function add(def: Omit<UserCodecDef, "id" | "createdAt">): string {
  const full: UserCodecDef = {
    ...def,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  snapshot = { codecs: [...snapshot.codecs, full] };
  emit();
  return full.id;
}

export function update(def: UserCodecDef) {
  snapshot = {
    codecs: snapshot.codecs.map((c) => (c.id === def.id ? { ...def } : c)),
  };
  emit();
}

export function remove(id: string) {
  snapshot = { codecs: snapshot.codecs.filter((c) => c.id !== id) };
  emit();
}

export function getById(id: string): UserCodecDef | null {
  return snapshot.codecs.find((c) => c.id === id) ?? null;
}

export function exportAll(): UserCodecDef[] {
  return structuredClone(snapshot.codecs);
}

/** 导入合并：重名协议自动加序号，id 一律重新生成避免冲突 */
export function importMerge(incoming: UserCodecDef[]): number {
  const taken = new Set(snapshot.codecs.map((c) => c.name));
  let n = 0;
  for (const raw of incoming) {
    if (!raw || !raw.name || !Array.isArray(raw.segs)) continue;
    let name = String(raw.name);
    let i = 2;
    while (taken.has(name)) name = `${raw.name} (${i++})`;
    taken.add(name);
    snapshot = {
      codecs: [
        ...snapshot.codecs,
        { ...raw, name, id: crypto.randomUUID(), createdAt: Date.now() },
      ],
    };
    n++;
  }
  if (n) emit();
  return n;
}
