/**
 * P174-R2：配置要真的递到插件里，不能只存在设置文件里。
 * 这里用源码钉住 hello 携带 config、bootstrap 暴露 ctx.config 两处，缺一处就是"保存了但插件读不到"。
 */
import { describe, expect, it } from "vitest";
import { versionArchivePath } from "./pluginEngine";

const fsSpec = "node:fs";
const urlSpec = "node:url";
const pathSpec = "node:path";
const { readFileSync } = (await import(fsSpec)) as unknown as { readFileSync: (p: string, enc?: string) => string };
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };
const { dirname, join } = (await import(pathSpec)) as unknown as { dirname: (p: string) => string; join: (...p: string[]) => string };
const here = dirname(fileURLToPath(import.meta.url));

describe("插件配置递送", () => {
  it("hello 携带生效配置", () => {
    expect(readFileSync(join(here, "pluginEngine.ts"), "utf8")).toContain("config: getEffectivePluginConfig(id)");
  });
  it("bootstrap 把 config 读进 ctx.config（只读快照）", () => {
    const src = readFileSync(join(here, "bootstrap.ts"), "utf8");
    expect(src).toContain("config = (m.config");
    expect(src).toContain("get config()");
  });
  it("版本归档目录不会出现在已安装列表里", () => {
    expect(readFileSync(join(here, "pluginEngine.ts"), "utf8")).toContain("item.name === VERSIONS_DIR");
  });
  it("归档路径是 .versions/<id>/<时间>-<版本>，版本里的非法字符被洗掉", () => {
    expect(versionArchivePath("C:/app/plugins", "a.b", "1.2.3", 36 * 36)).toBe("C:/app/plugins/.versions/a.b/100-1.2.3");
    expect(versionArchivePath("C:/app/plugins", "a.b", "1.0.0/beta", 36)).toBe("C:/app/plugins/.versions/a.b/10-1.0.0_beta");
  });
});
