/**
 * P99a-B：插件逻辑通道（`module` + 注册工具）的全部资源上限，单点定义。
 *
 * 单独一个文件的原因：这些数字要被 `moduleBus`（运行时闸门）、`toolSchemaLite`（校验器）、
 * 插件库 UI（能力差异展示）、以及测试（逐条钉上限）四方读。抄两份就是一份等着漂的假账（§8-36①）。
 */

/** 单个 `module` 产物源码上限在 artifact.ts（MAX_MODULE_BYTES），schema/实参上限在 toolSchemaLite.ts。 */
export const MODULE_CALL_TIMEOUT_MS = 10_000;
/** 每个包最多几个 `module` 产物。P99a-B2 的总线按包键控，一支 worker 跑一段代码。 */
export const MAX_MODULES_PER_PKG = 1;
/** 启用路径等封网自证的时限（比调用超时短：启用手感不能挂 10 秒） */
export const MODULE_PROBE_WAIT_MS = 4000;
/** 一次调用超时后重建 worker 的次数上限；再失控就判 dead，等人工停用/再启用。 */
export const MODULE_MAX_REBUILDS = 3;
/** worker 回传数据的上限；超过走 A7 截断标记，不静默裁。 */
export const PLUGIN_ACK_MAX_BYTES = 64 * 1024;
/** 每个插件最多注册几支工具。 */
export const PLUGIN_TOOLS_MAX_PER_PKG = 8;
/** 全局动态工具上限（防"装 20 个包各注册 8 支"把模型每轮请求体积打爆）。 */
export const PLUGIN_TOOLS_MAX_GLOBAL = 64;
/** 工具裸名/描述上限（描述进每一轮请求，必须有界）。 */
export const PLUGIN_TOOL_NAME_MAX = 40;
export const PLUGIN_TOOL_DESC_MAX = 600;
