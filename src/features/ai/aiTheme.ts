const KEY = "vs.aiTheme";

export type ThemeVars = Record<string, string>;

const VAR_RE = /^\-\-[a-z0-9-]+$/;

export function loadAiTheme(): ThemeVars | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw) as ThemeVars;
    return sanitizeVars(obj);
  } catch {
    localStorage.removeItem(KEY);
    return null;
  }
}

export function sanitizeVars(obj: Record<string, unknown>): ThemeVars | null {
  const out: ThemeVars = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (!VAR_RE.test(k) || typeof v !== "string") continue;
    if (v.length > 200 || /[;{}]/.test(v)) continue;
    out[k] = v;
    n++;
  }
  return n > 0 ? out : null;
}

export function applyAiTheme(vars: ThemeVars): boolean {
  const clean = sanitizeVars(vars);
  if (!clean) return false;
  localStorage.setItem(KEY, JSON.stringify(clean));
  const root = document.documentElement;
  for (const [k, v] of Object.entries(clean)) root.style.setProperty(k, v);
  return true;
}

export function clearAiTheme() {
  localStorage.removeItem(KEY);
  const root = document.documentElement;
  const stored = root.style.cssText;
  for (const decl of stored.split(";")) {
    const name = decl.split(":")[0]?.trim();
    if (name?.startsWith("--")) root.style.removeProperty(name);
  }
}
