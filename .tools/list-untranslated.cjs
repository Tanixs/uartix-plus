#!/usr/bin/env node
/**
 * P105-F 的干活工具：把一个文件里**还没走 i18n 的中文**按行列出来。
 *
 * 为什么要它：`check-i18n` 只给一个总数（"这个文件还有 251 汉字"），
 * 而改的人要的是"具体是哪 251 个字、在哪几行"。
 *
 * ⚠ 口径必须与那道门**同一份实现**，否则它就是一处新的第二真相。
 * 第一版这里自己抄了一遍正则，结果同一个文件报 471 而门报 251（口径不同：门只数
 * 字符串字面量 + JSX 文本节点两类）。第二版改成抄门的识别式 —— 仍然不对：
 * 那套正则会被英文里的 ASCII 撇号带偏、**漏报**真债（详见 `.tools/i18n-scan.cjs` 头注）。
 * 现在两边都从 `i18n-scan.cjs` 拿数，一行代码都不再各写一份。
 *
 * 用法：node .tools/list-untranslated.cjs src/features/settings/SettingsModal.tsx
 */
const path = require("path");
const { scanFile } = require("./i18n-scan.cjs");

const file = process.argv[2];
if (!file) {
  console.error("用法: node .tools/list-untranslated.cjs <file.tsx|file.ts>");
  process.exit(1);
}
const { total, hits } = scanFile(path.resolve(file));
for (const h of hits) {
  console.log(String(h.line).padStart(5) + "  " + String(h.chars).padStart(3) + "  " + h.text);
}
console.log("--- " + hits.length + " 处 / " + total + " 汉字");
if (total === 0) console.log("（这个文件已经干净；别忘了把 check-i18n 的预算行删掉）");
