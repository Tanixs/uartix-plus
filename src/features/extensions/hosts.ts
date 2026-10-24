/**
 * 插件市场 / v3 插件来源的**域白名单**（唯一一份）。
 *
 * 放这里而不是某条具体链路里：索引里出现的每个 URL、镜像前缀、ghSearch 与仓库归档都过它。
 * `registry.npmjs.org` 是 P99c-R2 加的（用户裁决：进白名单，只官方源）——
 * 门没有因此少一道：装的授权依据仍是"这条在索引里 + 哈希逐字节对得上"。
 *
 * **加域是一次信任面变更**：它等于宣布"这些主机上的字节可以进入安装链"，
 * 所以只加在这里，改一处就是改全部；别处只准 import，不许抄第二份。
 */
export const MARKET_ALLOW_HOSTS = [
  "raw.githubusercontent.com",
  "github.com",
  // P174-A13/A14：v3 插件的**话题检索**与**仓库归档**。两者都是 GitHub 自己的域：
  // - api.github.com：只用来读搜索结果（GET /search/repositories）；
  // - codeload.github.com：仓库归档（tar.gz 直给 200，不欠一次重定向）。
  // 加这两个是一次**信任面变更**，所以只加在这里：白名单只有一份，改一处就是改全部。
  "api.github.com",
  "codeload.github.com",
  "registry.npmjs.org",
];
