import type { SendMode } from "./controlsStore";

export interface CommandItem {
  id: string;
  name: string;
  template: string;
  sendMode: SendMode;
  note: string;
  script: string;
  scriptEnabled: boolean;
}

export interface CommandGroup {
  id: string;
  name: string;
  items: CommandNode[];
}

export type CommandNode = CommandItem | CommandGroup;

export interface CommandsSnapshot {
  groups: CommandGroup[];
}

export function isGroup(n: CommandNode): n is CommandGroup {
  return "items" in n;
}

function load(): CommandsSnapshot {
  try {
    const saved = localStorage.getItem("vs.commands");
    if (saved) {
      const parsed = JSON.parse(saved) as CommandsSnapshot;
      if (parsed.groups) {
        return {
          groups: parsed.groups.map((g) => migrateGroup(g)),
        };
      }
    }
  } catch {
    localStorage.removeItem("vs.commands");
  }
  return {
    groups: [
      {
        id: crypto.randomUUID(),
        name: "示例分组",
        items: [
          {
            id: crypto.randomUUID(),
            name: "复位",
            template: "RST!",
            sendMode: "ascii",
            note: "下位机复位",
            script: "",
            scriptEnabled: false,
          },
          {
            id: crypto.randomUUID(),
            name: "设速度",
            template: "SPD:%d!",
            sendMode: "ascii",
            note: "%d 会被替换为整数",
            script: "",
            scriptEnabled: false,
          },
        ],
      },
    ],
  };
}

function migrateGroup(raw: object): CommandGroup {
  const r = raw as Record<string, unknown>;
  const items = (r.items as Record<string, unknown>[]) ?? [];
  return {
    id: String(r.id ?? crypto.randomUUID()),
    name: String(r.name ?? "分组"),
    items: items.map((n) =>
      "items" in n
        ? migrateGroup(n)
        : {
            id: String(n.id ?? crypto.randomUUID()),
            name: String(n.name ?? "命令"),
            template: String(n.template ?? ""),
            sendMode: (n.sendMode as SendMode) ?? "ascii",
            note: String(n.note ?? ""),
            script: String(n.script ?? ""),
            scriptEnabled: Boolean(n.scriptEnabled),
          },
    ),
  };
}

let snapshot: CommandsSnapshot = load();
const listeners = new Set<() => void>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function emit() {
  snapshot = { ...snapshot };
  listeners.forEach((l) => l());
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    localStorage.setItem("vs.commands", JSON.stringify(snapshot));
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

function mapTree(
  items: CommandNode[],
  fn: (n: CommandNode) => CommandNode | null,
): CommandNode[] {
  const out: CommandNode[] = [];
  for (const n of items) {
    const r = fn(n);
    if (!r) continue;
    if (isGroup(r)) out.push({ ...r, items: mapTree(r.items, fn) });
    else out.push(r);
  }
  return out;
}

export function setScriptTrack(v: boolean) {
  void v;
}

export function addGroup(name: string, parentId?: string) {
  const g: CommandGroup = { id: crypto.randomUUID(), name, items: [] };
  if (!parentId) {
    snapshot = { ...snapshot, groups: [...snapshot.groups, g] };
  } else {
    snapshot = {
      ...snapshot,
      groups: mapTree(snapshot.groups, (n) =>
        isGroup(n) && n.id === parentId
          ? { ...n, items: [...n.items, g] }
          : n,
      ) as CommandGroup[],
    };
  }
  emit();
}

export function renameNode(id: string, name: string) {
  snapshot = {
    ...snapshot,
    groups: mapTree(snapshot.groups, (n) =>
      n.id === id ? { ...n, name } : n,
    ) as CommandGroup[],
  };
  emit();
}

export function removeNode(id: string) {
  const rec = (items: CommandNode[]): CommandNode[] =>
    items
      .filter((n) => n.id !== id)
      .map((n) => (isGroup(n) ? { ...n, items: rec(n.items) } : n));
  snapshot = {
    ...snapshot,
    groups: rec(snapshot.groups) as CommandGroup[],
  };
  emit();
}

export function addCommand(parentId: string) {
  snapshot = {
    ...snapshot,
    groups: mapTree(snapshot.groups, (n) =>
      isGroup(n) && n.id === parentId
        ? {
            ...n,
            items: [
              ...n.items,
              {
                id: crypto.randomUUID(),
                name: `命令${n.items.length + 1}`,
                template: "",
                sendMode: "ascii" as SendMode,
                note: "",
                script: "",
                scriptEnabled: false,
              },
            ],
          }
        : n,
    ) as CommandGroup[],
  };
  emit();
}

export function patchCommand(
  cmdId: string,
  patch: Partial<CommandItem>,
) {
  snapshot = {
    ...snapshot,
    groups: mapTree(snapshot.groups, (n) =>
      !isGroup(n) && n.id === cmdId ? { ...n, ...patch } : n,
    ) as CommandGroup[],
  };
  emit();
}

export function getCommand(cmdId: string): CommandItem | null {
  let found: CommandItem | null = null;
  const walk = (items: CommandNode[]) => {
    for (const n of items) {
      if (found) return;
      if (isGroup(n)) walk(n.items);
      else if (n.id === cmdId) found = n;
    }
  };
  walk(snapshot.groups);
  return found;
}

function findGroupById(
  items: CommandNode[],
  id: string,
): CommandGroup | null {
  for (const n of items) {
    if (isGroup(n)) {
      if (n.id === id) return n;
      const r = findGroupById(n.items, id);
      if (r) return r;
    }
  }
  return null;
}

function containsNode(items: CommandNode[], id: string): boolean {
  for (const n of items) {
    if (n.id === id) return true;
    if (isGroup(n) && containsNode(n.items, id)) return true;
  }
  return false;
}

function parentOf(
  items: CommandNode[],
  id: string,
  parent: string | null,
): string | null | undefined {
  for (const n of items) {
    if (n.id === id) return parent;
    if (isGroup(n)) {
      const r = parentOf(n.items, id, n.id);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}

export function moveNode(
  id: string,
  targetParentId: string | null,
  refId?: string | null,
  before?: boolean,
): boolean {
  if (id === targetParentId) return false;
  const cur = parentOf(snapshot.groups, id, null);
  if (cur === undefined) return false;
  if (targetParentId !== null) {
    const target = findGroupById(snapshot.groups, targetParentId);
    if (!target) return false;
    if (targetParentId === id || containsNode([{ ...target }], id))
      return false;
  }
  if (cur === targetParentId && !refId) return false;
  let node: CommandNode | null = null;
  const strip = (items: CommandNode[]): CommandNode[] =>
    items
      .filter((n) => {
        if (n.id === id) {
          node = n;
          return false;
        }
        return true;
      })
      .map((n) => (isGroup(n) ? { ...n, items: strip(n.items) } : n));
  let groups = strip(snapshot.groups) as CommandGroup[];
  const moved = node;
  if (!moved) return false;
  let arr: CommandNode[];
  if (targetParentId === null) {
    arr = groups;
  } else {
    const g = findGroupById(groups as CommandNode[], targetParentId);
    if (!g) return false;
    arr = g.items;
  }
  let idx = arr.length;
  if (refId) {
    const ri = arr.findIndex((n) => n.id === refId);
    if (ri >= 0) idx = before ? ri : ri + 1;
  }
  arr.splice(Math.max(0, Math.min(idx, arr.length)), 0, moved);
  snapshot = { ...snapshot, groups };
  emit();
  return true;
}

export function parentOfId(id: string): string | null | undefined {
  return parentOf(snapshot.groups, id, null);
}

export function flatCommands(): { item: CommandItem; depth: number }[] {
  const out: { item: CommandItem; depth: number }[] = [];
  const walk = (items: CommandNode[], depth: number) => {
    for (const n of items) {
      if (isGroup(n)) walk(n.items, depth + 1);
      else out.push({ item: n, depth });
    }
  };
  walk(snapshot.groups, 0);
  return out;
}

export function exportGroups(): CommandGroup[] {
  return structuredClone(snapshot.groups);
}

export function importGroupsMerge(incoming: CommandGroup[]) {
  const taken = new Set(snapshot.groups.map((g) => g.name));
  const cloned = structuredClone(incoming).map((g) => {
    let name = g.name;
    let i = 2;
    while (taken.has(name)) name = `${g.name} (${i++})`;
    taken.add(name);
    return { ...g, name, id: crypto.randomUUID() };
  });
  snapshot = { ...snapshot, groups: [...snapshot.groups, ...cloned] };
  emit();
}
