import * as plot3dStore from "../plot3d/plot3dStore";
import { isOperatorLocked } from "../operator/lock";

export const NOTE_MAX_CHARS = 2000;
export type NoteWriteMode = "append" | "replace";
/** Exact preview text; callers must reject previews over NOTE_MAX_CHARS before writing. */
export function previewGroupNote(baseline: string, draft: string, mode: NoteWriteMode): string {
  const text = draft.trim();
  return (mode === "append" && baseline ? `${baseline}${text ? `\n\n${text}` : ""}` : text).trim();
}

export type NoteWriteEntry = { gid: string; note: string; expectedNotes?: string | null };
export type NoteWriteOutcome = {
  written: string[];
  skipped: { gid: string; reason: "unknown-group" | "unchanged" | "conflict" | "locked" | "write-failed" }[];
};

/** A stale note snapshot cannot overwrite edits made while the draft was open. */
export function writeGroupNotes(entries: readonly NoteWriteEntry[]): NoteWriteOutcome {
  const outcome: NoteWriteOutcome = { written: [], skipped: [] };
  for (const entry of entries) {
    const group = plot3dStore.getSnapshot().settings.groups.find((g) => g.id === entry.gid);
    if (!group) { outcome.skipped.push({ gid: entry.gid, reason: "unknown-group" }); continue; }
    if (isOperatorLocked()) { outcome.skipped.push({ gid: entry.gid, reason: "locked" }); continue; }
    const note = entry.note.trim().slice(0, NOTE_MAX_CHARS);
    if (!note || note === group.notes) { outcome.skipped.push({ gid: entry.gid, reason: "unchanged" }); continue; }
    if (entry.expectedNotes === undefined || (entry.expectedNotes ?? "") !== group.notes) {
      outcome.skipped.push({ gid: entry.gid, reason: "conflict" });
      continue;
    }
    try {
      plot3dStore.updateGroup(group.id, { notes: note });
    } catch {
      outcome.skipped.push({ gid: entry.gid, reason: "write-failed" });
      continue;
    }
    // updateGroup can refuse a write (including an Operator transition); never claim success blindly.
    const saved = plot3dStore.getSnapshot().settings.groups.find((g) => g.id === entry.gid);
    if (saved?.notes === note) outcome.written.push(entry.gid);
    else outcome.skipped.push({ gid: entry.gid, reason: !saved ? "unknown-group" : isOperatorLocked() ? "locked" : "write-failed" });
  }
  return outcome;
}

/** Reads only stable group fields for AI evidence; never serializes buffers. */
export function groupNotesEvidence(): { id: string; name: string; notesLength: number }[] {
  return plot3dStore.getSnapshot().settings.groups
    .map((g) => ({ id: g.id, name: g.name, notesLength: g.notes.length }));
}
