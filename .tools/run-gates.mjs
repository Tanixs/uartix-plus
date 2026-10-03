/**
 * P133-A · 门禁链运行器（详设 §5-A）。
 *
 * 存在的理由：AI 要能自证"我改的代码没弄坏门禁"，但 `npm run check:all` 那条链今天只能靠
 * shell 跑；而 `shell_exec` 的半径是"任意命令"。把"能跑校验"绑在"能跑任何东西"上是不必要的半径，
 * 所以给出一条只跑这条链的通路。
 *
 * 为什么不算第二份门禁清单：链的唯一出处仍是 `package.json` 的 `scripts["check:all"]`，
 * 本文件只是把它拆开逐段执行（`scripts/gateWiring.test.mjs` 钉着"每张门都在这条链里"）。
 * 抄一份 14 行的数组就是第二真相——加一道门要改两处、漏一处就是一道没人跑的门。
 *
 * 用法：
 *   node .tools/run-gates.mjs            # 逐道跑，第一道红即止（与 && 同语义）
 *   node .tools/run-gates.mjs --list     # 只打印解析出来的 argv 表（给测试与工具面用）
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const PKG = new URL("../package.json", import.meta.url);

/** `a && b && c` → [["node","x.cjs"], ["node","y.cjs"]]。段内多余空白与换行都吃掉。 */
function parseChain(spec) {
  return spec
    .split("&&")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(/\s+/));
}

const spec = JSON.parse(readFileSync(fileURLToPath(PKG), "utf8")).scripts["check:all"];
if (!spec) {
  console.error("package.json 没有 scripts.check:all");
  process.exit(2);
}
const chain = parseChain(spec);

if (process.argv.includes("--list")) {
  console.log(JSON.stringify(chain));
  process.exit(0);
}

console.log(`门禁 ${chain.length} 道（出处：package.json scripts["check:all"]）`);
for (const [i, argv] of chain.entries()) {
  console.log(`\n── [${i + 1}/${chain.length}] ${argv.join(" ")}`);
  const r = spawnSync(argv[0], argv.slice(1), { stdio: "inherit", shell: false });
  if (r.error) {
    console.error(`启动失败：${r.error.message}`);
    process.exit(127);
  }
  if (r.status !== 0) {
    console.error(`\n✗ 第 ${i + 1} 道判红（退出码 ${r.status}）——后面的 ${chain.length - i - 1} 道没跑（&& 语义）`);
    process.exit(r.status ?? 1);
  }
}
console.log(`\nOK: ${chain.length} 道门禁全绿`);
