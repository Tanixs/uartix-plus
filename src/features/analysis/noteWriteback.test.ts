import { beforeEach, describe, expect, it, vi } from "vitest";
import { NOTE_MAX_CHARS, previewGroupNote, writeGroupNotes, groupNotesEvidence } from "./noteWriteback";
import * as lock from "../operator/lock";

const groups = [
  { id: "g1", name: "Group 1", notes: "base" },
  { id: "g2", name: "Group 2", notes: "" },
];
vi.mock("../plot3d/plot3dStore", () => ({
  getSnapshot: () => ({ settings: { groups } }),
  updateGroup: vi.fn(),
}));
vi.mock("../operator/lock", () => ({ isOperatorLocked: vi.fn(() => false) }));
const updateGroup = vi.mocked((await import("../plot3d/plot3dStore")).updateGroup);

beforeEach(() => {
  groups.splice(0, groups.length,
    { id: "g1", name: "Group 1", notes: "base" },
    { id: "g2", name: "Group 2", notes: "" });
  updateGroup.mockReset();
  updateGroup.mockImplementation((gid, patch) => {
    const group = groups.find((g) => g.id === gid);
    if (group && patch.notes !== undefined) group.notes = patch.notes;
  });
  vi.mocked(lock.isOperatorLocked).mockReset().mockReturnValue(false);
});

describe("group note writeback", () => {
  it("appends with optimistic concurrency and skips unknown, unchanged and conflicting entries", () => {
    const outcome = writeGroupNotes([
      { gid: "g1", note: "appended", expectedNotes: "base" },
      { gid: "ghost", note: "x" },
      { gid: "g2", note: "  same  ", expectedNotes: "same" },
      { gid: "g2", note: "stale", expectedNotes: "stale-read" },
      { gid: "g1", note: "" },
    ]);
    expect(outcome.written).toEqual(["g1"]);
    expect(outcome.skipped).toEqual([
      { gid: "ghost", reason: "unknown-group" },
      { gid: "g2", reason: "conflict" },
      { gid: "g2", reason: "conflict" },
      { gid: "g1", reason: "unchanged" },
    ]);
    expect(updateGroup).toHaveBeenCalledTimes(1);
    expect(updateGroup).toHaveBeenCalledWith("g1", { notes: "appended" });
  });

  it("truncates to the documented limit and honors the Operator lock without fake success", () => {
    const long = "n".repeat(2100);
    const outcome = writeGroupNotes([{ gid: "g2", note: long, expectedNotes: "" }]);
    expect(outcome.written).toEqual(["g2"]);
    expect(updateGroup).toHaveBeenCalledWith("g2", { notes: "n".repeat(2000) });
    updateGroup.mockClear();
    vi.mocked(lock.isOperatorLocked).mockReturnValue(true);
    const locked = writeGroupNotes([{ gid: "g1", note: "edit", expectedNotes: "base" }]);
    expect(locked).toEqual({ written: [], skipped: [{ gid: "g1", reason: "locked" }] });
    expect(updateGroup).not.toHaveBeenCalled();
  });

  it("previews append and replace without writing, preserving the baseline", () => {
    expect(previewGroupNote("base", "  pasted AI response  ", "append")).toBe("base\n\npasted AI response");
    expect(previewGroupNote("base", "  replacement  ", "replace")).toBe("replacement");
    expect(previewGroupNote("", "note", "append")).toBe("note");
    expect(previewGroupNote("base", "  ", "append")).toBe("base");
    expect(previewGroupNote("base", "n".repeat(NOTE_MAX_CHARS), "append").length).toBeGreaterThan(NOTE_MAX_CHARS);
    expect(updateGroup).not.toHaveBeenCalled();
    expect(groups[0].notes).toBe("base");
  });

  it("writes exactly the reviewed append/replace preview and rejects reused stale baselines", () => {
    const expectedNotes = groups[0].notes;
    const note = previewGroupNote(expectedNotes, "pasted response", "append");
    expect(writeGroupNotes([{ gid: "g1", note, expectedNotes }]).written).toEqual(["g1"]);
    expect(groups[0].notes).toBe(note);
    expect(writeGroupNotes([{ gid: "g1", note: "later", expectedNotes }]).skipped).toEqual([{ gid: "g1", reason: "conflict" }]);
    const replacement = previewGroupNote(note, "replacement", "replace");
    expect(writeGroupNotes([{ gid: "g1", note: replacement, expectedNotes: note }]).written).toEqual(["g1"]);
    expect(groups[0].notes).toBe(replacement);
  });

  it("rejects missing baselines and concurrent edits without overwriting", () => {
    const expectedNotes = groups[0].notes;
    groups[0].notes = "someone else's edit";
    expect(writeGroupNotes([
      { gid: "g1", note: "stale preview", expectedNotes },
      { gid: "g2", note: "blind overwrite" },
    ]).skipped).toEqual([{ gid: "g1", reason: "conflict" }, { gid: "g2", reason: "conflict" }]);
    expect(groups[0].notes).toBe("someone else's edit");
    expect(updateGroup).not.toHaveBeenCalled();
  });

  it("normalizes null baseline only for empty notes and skips unchanged notes", () => {
    expect(writeGroupNotes([{ gid: "g2", note: "text", expectedNotes: null }]).written).toEqual(["g2"]);
    expect(groups[1].notes).toBe("text");
    expect(writeGroupNotes([{ gid: "g2", note: " text ", expectedNotes: "text" }]).skipped).toEqual([{ gid: "g2", reason: "unchanged" }]);
    expect(updateGroup).toHaveBeenCalledTimes(1);
  });

  it("does not report success for a refused, throwing, or altered write", () => {
    updateGroup.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("failed"); })
      .mockImplementationOnce(() => { groups[0].notes = "different"; });
    for (let i = 0; i < 3; i++) {
      expect(writeGroupNotes([{ gid: "g1", note: "new", expectedNotes: "base" }])).toEqual({
        written: [], skipped: [{ gid: "g1", reason: "write-failed" }],
      });
    }
  });

  it("reports Operator transitions and group deletion during writes", () => {
    updateGroup.mockImplementationOnce(() => { vi.mocked(lock.isOperatorLocked).mockReturnValue(true); });
    expect(writeGroupNotes([{ gid: "g1", note: "new", expectedNotes: "base" }])).toEqual({
      written: [], skipped: [{ gid: "g1", reason: "locked" }],
    });
    expect(groups[0].notes).toBe("base");
    vi.mocked(lock.isOperatorLocked).mockReturnValue(false);
    updateGroup.mockImplementationOnce(() => { groups.splice(0, 1); });
    expect(writeGroupNotes([{ gid: "g1", note: "new", expectedNotes: "base" }])).toEqual({
      written: [], skipped: [{ gid: "g1", reason: "unknown-group" }],
    });
  });

  it("exposes only stable group fields as evidence", () => {
    expect(groupNotesEvidence()).toEqual([
      { id: "g1", name: "Group 1", notesLength: 4 },
      { id: "g2", name: "Group 2", notesLength: 0 },
    ]);
  });
});
