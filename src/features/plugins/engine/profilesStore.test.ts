/**
 * P174-B2：Profile IO 层的接线钉。
 *
 * 纯判据由 `profiles.test.ts` 钉；这里只防一类退化：把“应用/回退”改成了自己手搓的
 * 另一条路（绕过 plan、绕过 scope、绕过 persist），而纯测试仍然全绿。
 */
import { describe, expect, it } from "vitest";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const pathSpec = "node:path";
const { readFileSync } = (await import(fsSpec)) as unknown as { readFileSync: (p: string, enc?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const { dirname, join } = (await import(pathSpec)) as unknown as {
  dirname: (p: string) => string;
  join: (...p: string[]) => string;
};

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "profilesStore.ts"), "utf8");

function bodyOf(name: string): string {
  const m = new RegExp(`(?:export\\s+)?async\\s+function\\s+${name}\\s*\\(`).exec(src);
  if (!m) return "";
  const rest = src.slice(m.index + 1);
  const next = rest.search(/\n(?:export\s+)?(?:async\s+)?function\s+/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("profilesStore 接线", () => {
  it("应用场景必须：先回退旧场景 → 纯计划 → 执行器 → 落 activeId/快照 → 审计", () => {
    const body = bodyOf("applyProfile");
    expect(body).toContain("revertActiveProfile()");
    expect(body).toContain("planProfileApply(");
    expect(body).toContain("applyProfilePlan(");
    expect(body).toContain("persist(");
    expect(body).toContain("recordProfileEvent(");
  });

  it("回退必须走 revertProfileState，失败不清活动状态", () => {
    const body = bodyOf("revertActiveProfile");
    expect(body).toContain("revertProfileState(");
    expect(body).toContain("if (r.failed)");
    expect(body).toContain("throw new Error");
    expect(body).toContain("delete next.applied");
  });

  it("所有会写账本的入口都先 ensureProfilesLoaded（防止用空账覆盖已存场景）", () => {
    for (const name of ["saveProfile", "createProfile", "saveCurrentAsProfile", "duplicateProfile", "deleteProfile"]) {
      expect(bodyOf(name), name).toContain("await ensureProfilesLoaded()");
    }
  });

  it("持久化只有一个出口（saveProfiles），不在别处直写", () => {
    expect(src.match(/saveProfiles\(/g)?.length).toBe(1);
    expect(bodyOf("persist")).toContain("saveProfiles(");
  });
});
