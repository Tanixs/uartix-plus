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
