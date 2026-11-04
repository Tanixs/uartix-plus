/**
 * 插件体积与传输上限的**唯一来源**（TS 侧）。
 *
 * 为什么单独一份：这些数字原来散在清单校验、解包、草稿写入、市场下载、发布、
 * 面板读取断言里，每一处都各写一遍 `8 * 1024 * 1024` 之类。改一次要全仓找，
 * 漏一处就出现"装得上但打不开""读得出来但发不出去"这种最难查的组合。
 *
 * Rust 侧对应文件是 `src-tauri/src/plugin_limits.rs`，两边是同一组数字的两份投影：
 * 前端管"允许写进 IPC 的量"，Rust 管"真正落盘/出网的量"。改一处必须改另一处，
 * 否则前端的错误会变成 Rust 的一句 `content_too_large`，现象指错方向。
 *
 * **这些值只在新构建里生效。** 0.6.4 那版安装包里的 `plugin_fs_read` 仍是 256 KiB，
 * 改源码不会改变已经在用户机器上的旧二进制；面板要正常显示必须等下一版构建安装后。
 */

/** 单个文件上限。面板、main.mjs、图片、包内任意文件都受这一条约束。 */
export const PLUGIN_MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * 一个插件包解压后的总字节上限。
 * 它比单文件大得多：一个插件可以有多张图、多个 runner，但"一个包"不该是一份数据仓库。
 */
export const PLUGIN_MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

/** 包内文件数上限（`node_modules` 会很快吃掉它，所以给得足够宽）。 */
export const PLUGIN_MAX_FILES = 2000;

/**
 * 清单本体上限。清单是元数据，不是代码/图片；1 MiB 已经比任何正常清单宽两个数量级。
 * 它与"包内单文件 16 MiB"不是一回事：这里防的是把资源塞进清单。
 */
export const PLUGIN_MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * 市场读远端清单的响应上限。GitHub 的 contents API 会把 `plugin.json` 包在
 * 一层 base64 JSON 里（约 1.4 倍），所以网络响应要比清单本体宽一档。
 */
export const PLUGIN_MANIFEST_FETCH_MAX_BYTES = 2 * PLUGIN_MAX_MANIFEST_BYTES;

/**
 * 一次发布 / 一次草稿批量写入的**合计上限**（按 base64 计，48 MiB ≈ 36 MiB 原文件）。
 * 它和 `PLUGIN_MAX_PACKAGE_BYTES` 不是一回事：后者是磁盘占用，这里是单次网络/IPC 载荷。
 */
export const PLUGIN_MAX_TRANSFER_BYTES = 48 * 1024 * 1024;

/**
 * 市场归档（`.tar.gz`）的下载上限。
 * 与单文件同档：GitHub 的仓库归档是压缩包，16 MiB 压缩后通常能展开成远小于 64 MiB 的包；
 * 真正的展开上限由 `PLUGIN_MAX_PACKAGE_BYTES` 把关（解包时逐文件累加）。
 */
export const PLUGIN_MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;

/**
 * 面板读取上限。**这是防截断的护栏，不是配额**。
 *
 * 0.6.0 踩过一次：宿主 `plugin_fs_read` 上限 256 KiB，面板长到 269,635 字节，
 * 尾部 `<script>` 被截掉 ⇒ 整页空白、按钮全死。所以这个值必须大于任何"能合法装进包"
 * 的文件（`PLUGIN_MAX_FILE_BYTES`），而不是一个用来限制插件功能的数字。
 */
export const PANEL_READ_MAX_BYTES = PLUGIN_MAX_FILE_BYTES;

/** base64 读取上限（封面/截图/二进制回传）。与文本读取同源，避免"能装不能读"。 */
export const PLUGIN_MAX_READ_B64_BYTES = PLUGIN_MAX_FILE_BYTES;

/** 发布单文件上限。与包内单文件同源：装得进包的文件就该发得出去。 */
export const PLUGIN_MAX_PUBLISH_FILE_BYTES = PLUGIN_MAX_FILE_BYTES;

/** 发布文件数上限。Rust 侧 `MAX_FILES` 必须与它一致。 */
export const PLUGIN_MAX_PUBLISH_FILES = 12;

/**
 * 一次草稿写入的文件数上限。**这是 IPC/模型上下文的地板，不是权限**：
 * 一次工具调用塞 2000 个文件进 JSON，先炸的是模型上下文。包数量本身另受 `PLUGIN_MAX_FILES` 约束。
 */
export const PLUGIN_DRAFT_WRITE_FILES = 200;

/**
 * 主题 CSS 的字节上限。它与"文件能读多大"是两个数：那个管**读盘**（16 MiB），
 * 这个管**渲染**——一份 16 MiB 的 CSS 会让整张界面卡死，而主题的职责只是换配色。
 */
export const PLUGIN_THEME_CSS_MAX_BYTES = 200 * 1024;

/** 发布内容合计（base64 字符数）。Rust 侧 `MAX_TOTAL_B64` 必须与它一致。 */
export const PLUGIN_MAX_PUBLISH_TOTAL_B64 = PLUGIN_MAX_TRANSFER_BYTES;

/**
 * 市场取回的逐请求上限（市场命令的硬顶）。
 * Rust 侧 `market_fetch` 会把前端要的上限夹到这条以内；16 MiB 正好覆盖归档单文件。
 */
export const PLUGIN_MARKET_FETCH_MAX_BYTES = PLUGIN_MAX_ARCHIVE_BYTES;

/** 市场取回超时。16 MiB 的归档在慢网/代理下 20 秒不够，放宽到 60 秒。 */
export const PLUGIN_MARKET_TIMEOUT_MS = 60_000;

/** 发布请求超时。单文件 PUT 从慢网传 20 MiB 的 base64，25 秒同样不够。 */
export const PLUGIN_PUBLISH_TIMEOUT_MS = 120_000;

/** 宿主 stdio 单行上限（Rust 侧 `plugin_host_send` 的硬顶）。 */
export const PLUGIN_HOST_LINE_MAX_BYTES = PLUGIN_MAX_FILE_BYTES;

/**
 * 展示层图片上限（插件封面/截图）。
 *
 * **刻意不跟随 16 MiB**：这两张图存在 `localStorage`（`vs.pluginMeta.v1`），
 * 浏览器给的配额只有几 MB；把它们放到 16 MiB 只会让整份元信息账本写不进去，
 * 表现是"封面全没了"。它们不是插件包内容，不属于"空间上限"要放开的范围。
 */
export const PLUGIN_META_COVER_MAX_BYTES = 256 * 1024;
export const PLUGIN_META_SHOT_MAX_BYTES = 256 * 1024;
export const PLUGIN_META_TOTAL_MAX_BYTES = 1024 * 1024;

/** 人话字节数，用于错误里"超过 16 MiB"这类句子，避免每处各写一个换算。 */
export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) {
    const mib = n / (1024 * 1024);
    return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
  }
  if (n >= 1024) {
    const kib = n / 1024;
    return `${Number.isInteger(kib) ? kib : kib.toFixed(1)} KiB`;
  }
  return `${n} B`;
}
