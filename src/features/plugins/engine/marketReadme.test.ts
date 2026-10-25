/**
 * P174-R17：README 预览图的解析判据。
 *
 * 详情页的图现在会被抓成 data URL（raw 在部分网络不可达），所以"哪些图能抓"必须
 * 在**解析这一层**定死：只认 GitHub 自家图床、只留本仓路径、包根封面不重复抓。
 */
import { describe, expect, it } from "vitest";
import { readmeImageRefs, readmePreviewRefs } from "./marketReadme";
import type { GhRepo } from "./ghSearch";

const repo = {
  full: "o/n",
  owner: "o",
  name: "n",
  defaultBranch: "main",
  description: "",
  stars: 0,
  updated: "",
  htmlUrl: "",
  topics: [],
  archived: false,
} satisfies GhRepo;

describe("P174-R17 · README 图引用", () => {
  it("相对路径、HTML img、仓库内绝对 raw 地址都能解析出相对路径", () => {
    const md = [
      "![cover](cover.jpg)",
      "![shot](docs/shot%201.png)",
      '<img src="https://raw.githubusercontent.com/o/n/main/logo.svg" />',
    ].join("\n");
    expect(readmeImageRefs(repo, md).map((r) => r.path)).toEqual(["cover.jpg", "docs/shot 1.png", "logo.svg"]);
    expect(readmeImageRefs(repo, md)[1].url).toBe("https://raw.githubusercontent.com/o/n/main/docs/shot%201.png");
  });

  it("别的图床与解析到别的仓库的地址只留 URL、不留路径（绝不能拼进 contents API）", () => {
    const md = [
      "![x](https://user-images.githubusercontent.com/1/x.png)",
      "![y](../escaped.png)",
      "![z](https://raw.githubusercontent.com/other/repo/main/a.png)",
    ].join("\n");
    const refs = readmeImageRefs(repo, md);
    // user-images 直接丢；`../` 解析成另一个 raw 地址、别的仓库也是 raw——两者都只留 URL
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.path)).toEqual([undefined, undefined]);
    expect(refs[0].url).toBe("https://raw.githubusercontent.com/o/n/escaped.png");
    expect(refs[1].url).toContain("/other/repo/");
  });

  it("包根 cover.* 不重复抓（详情第一张已经是它），子目录里的同名图保留", () => {
    const md = "![a](cover.png)\n![b](docs/cover.png)\n![c](shot.jpg)";
    expect(readmePreviewRefs(repo, md).map((r) => r.path)).toEqual(["docs/cover.png", "shot.jpg"]);
  });

  it("坏编码不抛异常；重复引用只留一条", () => {
    const md = "![a](a%ZZ.png)\n![a](a%ZZ.png)\n![b](b.png)";
    const refs = readmeImageRefs(repo, md);
    expect(refs).toHaveLength(2);
    expect(refs[0].path).toBeUndefined();
    expect(refs[1].path).toBe("b.png");
  });
});
