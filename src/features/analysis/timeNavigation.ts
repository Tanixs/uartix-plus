import * as session from "../session/sessionStore";
import * as cursor from "./timeCursorStore";

type Target = { tsMs: number; source: cursor.CursorSource; revision: number };
let pending: Target | null = null;
let running = false;
let revision = 0;
let preview: cursor.CursorSource | null = null;
let previous = session.getSnapshot();
const replaying = (s: ReturnType<typeof session.getSnapshot>) => s.state === "playing" || s.state === "paused";

/** Detect session replacement/exit even while a seek is awaiting IPC. */
function checkSession() {
  const s = session.getSnapshot();
  const changed = s.fileName !== previous.fileName ||
    ((replaying(s) || replaying(previous)) &&
      (s.firstTs !== previous.firstTs || s.lastTs !== previous.lastTs || replaying(s) !== replaying(previous))) ||
    (s.state === "idle" && previous.state !== "idle");
  previous = { ...s };
  if (changed) {
    revision++;
    pending = null;
    preview = null;
    cursor.locate(null, "session");
    cursor.setRange(null);
  }
  return s;
}

export function previewTime(tsMs: number, source: cursor.CursorSource) {
  if (!Number.isFinite(tsMs)) return;
  checkSession();
  preview = source;
  revision++;
  cursor.locate(tsMs, source);
}

/** Release a cancelled/unmounted gesture without issuing a seek. */
export function cancelPreview(source: cursor.CursorSource) {
  if (preview !== source) return;
  preview = null;
  revision++;
  syncClock();
}

/** Resume latest/current replay time; never seek to the end of the recording. */
export function returnLatest(source: cursor.CursorSource) {
  preview = null;
  pending = null;
  revision++;
  cursor.locate(null, source);
}

export async function navigateTime(tsMs: number, source: cursor.CursorSource): Promise<void> {
  const s = checkSession();
  if (preview === source) preview = null;
  if (!Number.isFinite(tsMs)) { syncClock(); return; }
  if (!replaying(s)) {
    revision++;
    cursor.locate(tsMs, source);
    return;
  }
  if (!(s.lastTs > s.firstTs) || tsMs < s.firstTs || tsMs > s.lastTs) { syncClock(); return; }
  pending = { tsMs, source, revision: ++revision };
  if (running) return;
  running = true;
  const paused = s.state === "paused";
  const speed = Number.isFinite(s.lastSpeed) && s.lastSpeed >= 0 ? s.lastSpeed : 1;
  const sameSession = () => {
    const current = checkSession();
    return replaying(current) && current.fileName === s.fileName &&
      current.firstTs === s.firstTs && current.lastTs === s.lastTs;
  };
  try {
    while (pending) {
      const target = pending;
      pending = null;
      if (!sameSession()) break;
      const ok = await session.seek((target.tsMs - s.firstTs) / (s.lastTs - s.firstTs), speed);
      if (!ok || !sameSession()) break;
      if (paused && !(await session.pause())) break;
      if (!sameSession()) break;
      // A newer preview, return-latest or reset must not be overwritten by late IPC.
      if (target.revision === revision) cursor.locate(target.tsMs, target.source);
    }
  } finally {
    pending = null;
    running = false;
  }
}

function syncClock() {
  const s = checkSession();
  if (!running && preview === null && replaying(s) && s.lastTs > s.firstTs) {
    cursor.locate(Math.min(s.lastTs, Math.max(s.firstTs, s.firstTs + s.posMs)), "session");
  }
}

/** Immediate mount reconciliation plus a single ref-counted session subscription. */
let clockUsers = 0;
let stopClock: (() => void) | null = null;
export function subscribeReplayClock(): () => void {
  if (clockUsers++ === 0) {
    previous = { ...session.getSnapshot() };
    stopClock = session.subscribe(syncClock);
  }
  syncClock();
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    if (--clockUsers === 0) {
      stopClock?.();
      stopClock = null;
      preview = null;
    }
  };
}
