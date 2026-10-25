/**
 * P174-R17：市场封面的三条判据。
 *
 * 封面是**约定取回**（仓库根 cover.png/jpg/webp），不是清单字段；这三组用例钉的是
 * "地址拼得对、不是图片不硬塞、没图也有一枚稳定的文字砖"——三处任一处松了，
 * 用户看到的就是破图或白块。
 */
import { describe, expect, it } from "vitest";
import {
  COVER_FILES,
  coverCandidates,
  coverHue,
  coverInitials,
  gitHubFileBytes,
  imageMime,
} from "./marketCover";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x20, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

describe("P174-R17 · 封面地址", () => {
  it("JPEG 优先，再 PNG/WebP；走和搜索同一条 API（raw 在部分网络不可达）", () => {
    const urls = coverCandidates({ owner: "Tanixs", name: "uartix.yolo", defaultBranch: "main" });
    expect(urls).toEqual([
      "https://api.github.com/repos/Tanixs/uartix.yolo/contents/cover.jpg?ref=main",
      "https://api.github.com/repos/Tanixs/uartix.yolo/contents/cover.png?ref=main",
      "https://api.github.com/repos/Tanixs/uartix.yolo/contents/cover.webp?ref=main",
    ]);
    expect(COVER_FILES).toHaveLength(urls.length);
  });

  it("分支是查询参数：斜杠整体编码；名字里的空格不会拼出第二个路径段", () => {
    const urls = coverCandidates({ owner: "a b", name: "x", defaultBranch: "feat/cover" });
    expect(urls[0]).toContain("/a%20b/x/contents/cover.jpg?ref=feat%2Fcover");
  });

  it("分支缺省回落 main，坏段（..）被丢弃", () => {
    const urls = coverCandidates({ owner: "o", name: "n", defaultBranch: "../x" });
    expect(urls[0]).toBe("https://api.github.com/repos/o/n/contents/cover.jpg?ref=x");
    expect(coverCandidates({ owner: "", name: "n", defaultBranch: "main" })).toEqual([]);
  });
});

describe("P174-R17 · contents API 的文件信封", () => {
  const b64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...Array.from(bytes)));
  const envelope = (bytes: Uint8Array, over: Record<string, unknown> = {}) =>
    JSON.stringify({ encoding: "base64", size: bytes.length, content: b64(bytes), ...over });

  it("base64 还原成原始字节（GitHub 会在 content 里塞换行，先剥掉）", () => {
    const wrapped = b64(PNG).replace(/(.{4})/g, "$1\n");
    const got = gitHubFileBytes(JSON.stringify({ encoding: "base64", content: wrapped, size: PNG.length }));
    expect(Array.from(got ?? [])).toEqual(Array.from(PNG));
    expect(imageMime(got!)).toBe("image/png");
  });

  it("不是 JSON / 不是 base64 / 超预算 / 空内容都不算封面", () => {
    expect(gitHubFileBytes("<!doctype html>")).toBeNull();
    expect(gitHubFileBytes(envelope(PNG, { encoding: "utf-8" }))).toBeNull();
    expect(gitHubFileBytes(envelope(PNG, { size: 9_000_000 }))).toBeNull();
    expect(gitHubFileBytes(envelope(PNG, { size: 0 }))).toBeNull();
    expect(gitHubFileBytes(JSON.stringify({ encoding: "base64", content: "" }))).toBeNull();
  });
});

describe("P174-R17 · 只认能直接显示的图片", () => {
  it("PNG / JPEG / WebP 三个文件头", () => {
    expect(imageMime(PNG)).toBe("image/png");
    expect(imageMime(JPG)).toBe("image/jpeg");
    expect(imageMime(WEBP)).toBe("image/webp");
  });

  it("HTML 错误页、空响应、太短的字节都不算图", () => {
    expect(imageMime(new TextEncoder().encode("<!doctype html><title>404</title>"))).toBeNull();
    expect(imageMime(new Uint8Array([]))).toBeNull();
    expect(imageMime(new Uint8Array([0x89, 0x50]))).toBeNull();
  });
});

describe("P174-R17 · 没有封面时的文字砖", () => {
  it("多词取首字母，单词取首字，中文按字取", () => {
    expect(coverInitials("fluent-dark")).toBe("FD");
    expect(coverInitials("uartix.yolo")).toBe("UY");
    expect(coverInitials("midnight")).toBe("M");
    expect(coverInitials("串口 工具")).toBe("串工");
    expect(coverInitials("")).toBe("?");
  });

  it("同一名字永远同一色相，且落在 0..359", () => {
    const a = coverHue("Tanixs/uartix.yolo");
    expect(a).toBe(coverHue("Tanixs/uartix.yolo"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(360);
    expect(coverHue("Tanixs/midnight")).not.toBe(a);
  });
});
