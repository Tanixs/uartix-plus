/**
 * P114-A ·「模型测试」的判据钉（详设 §1.4）。
 *
 * 事故本身：那颗按钮 `await invoke("ai_chat")` 之后就把 `probe` 设成 ok，并显示
 * `已应答 · ${Date.now()-t0}ms`。而 `ai_chat` 是流式命令，签名 `Result<(), String>`，
 * 它的每一条失败分支（建 client 失败 / 连不上 / HTTP 4xx·5xx / 流中途断）都是
 * `emit("ai:error",{reqId,msg})` + `return Ok(())`；错误按 reqId 派发，而 `probe-<uuid>`
 * 没人监听（`chatStore.ts` 的 ai:error 第一行就把陌生 reqId 丢了）。
 * 于是"删掉 API Key 的一个字母"仍然是绿的，那个 ms 还是真实的一个完整往返——
 * **时间是真机制，判定是假判据**。修法是换一条判定写在类型里的命令 `ai_probe`。
 *
 * 手法说明：没有 RTL，"点下去界面真的变红了"测不到（那是验收清单，用户真机执行）；
 * 能钉的是**判定从哪来、错误原文有没有被半路截掉**。每条都配了反证（详设 §4 证伪表）。
 */
import { describe, expect, it } from "vitest";
// 本仓 tsc 没有 @types/node：读盘走变量说明符（同 themeWiring.test 的写法）
const fsSpec = "node:fs";
const urlSpec = "node:url";
const { readFileSync } = (await import(fsSpec)) as {
  readFileSync: (p: string, e?: string) => string;
};
const { fileURLToPath } = (await import(urlSpec)) as { fileURLToPath: (u: string | URL) => string };

const SRC = fileURLToPath(new URL("../../", import.meta.url)); // → src/
const ROOT = fileURLToPath(new URL("../../../", import.meta.url)); // → 仓库根
const read = (rel: string) => readFileSync(`${SRC}${rel}`, "utf8");
const readAt = (rel: string) => readFileSync(`${ROOT}${rel}`, "utf8");

const PAGE = "features/settings/ModelSettingsPage.tsx";
const CHAT = "features/ai/chatStore.ts";
const AI_RS = "src-tauri/src/ai.rs";
const LIB_RS = "src-tauri/src/lib.rs";

describe("P114-A · 逐模型「测试」的判定来源", () => {
  it("模型设置页里不许再出现 invoke(\"ai_chat\")——它的 Ok 证明不了模型答过话", () => {
    const src = read(PAGE);
    // 只钉调用形状：注释里写 ai_chat 是在解释为什么不用它，那是正当出现
    expect(/invoke\(\s*"ai_chat"/.test(src), "这一页又拿「命令返回了」当「模型应答了」").toBe(false);
  });

  it("它走 ai_probe，并且连接参数仍只从 aiWireArgs 出来（密钥清洗不许绕开）", () => {
    const src = read(PAGE);
    expect(/invoke<string>\(\s*"ai_probe"/.test(src), "探针不再走 ai_probe，判定可能退回假判据").toBe(true);
    expect(/invoke<string>\(\s*"ai_probe",\s*aiWireArgs\(/.test(src), "绕开 aiWireArgs 自己拼连接参数 = 回到 P108 那类事故").toBe(true);
  });

  it("前端 invoke 的每个宿主命令都得在 ai.rs 里真有定义（改名/打错的探针会静默失败）", () => {
    const ai = readAt(AI_RS);
    const called = [...read(PAGE).matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(called.length, "这一页一个宿主命令都不调了？那这条钉就该删").toBeGreaterThan(0);
    for (const cmd of new Set(called)) {
      expect(new RegExp(`pub async fn ${cmd}\\b`).test(ai), `${cmd} 在 ai.rs 里不存在`).toBe(true);
    }
  });

  it("上游错误原文整句留给界面，不许 slice 成看不懂的半句", () => {
    const src = read(PAGE);
    expect(/String\(e\)\.slice\(/.test(src), "错误被截断了：用户要求「直接显示返回的错误信息」").toBe(false);
    // 两条试连路径（供应商级 ↻ 与逐模型）的错误转文字只经 `errText` 一处，
    // 否则"去掉 Error: 前缀""截多长"会各写一份、各自漂
    expect((src.match(/\bString\(e\)/g) ?? []).length, "又出现第二处自己转字符串的错误处理").toBe(1);
    // 「失败：」那个前缀也一并撤了：classify_error 的第一句就是可行动的判定，点色已经说了成败
    expect(src.includes("失败：${note}"), "重复的失败前缀回来了").toBe(false);
  });
});

describe("P114-A · ai_probe 的返回类型就是它的判据", () => {
  const ai = readAt(AI_RS);
  const sig = ai.slice(ai.indexOf("pub async fn ai_probe"), ai.indexOf("pub async fn ai_probe") + 700);

  it("Ok 带着上游回的文字（界面用它当凭据），不是 Result<(), _>", () => {
    expect(/-> Result<String, String>/.test(sig), "签名退了回去：调用方又只能拿「没抛异常」当成功").toBe(true);
  });

  it("判定表在 `probe_verdict` 里，`ai_probe` 只负责把状态码与响应体交给它", () => {
    // P114-A 收尾时挪的一处：判据原来内联在 `ai_probe` 里，那样只能靠真网络才能验，
    // 拆成纯函数后 `cargo test` 里 probe_verdict_4 条逐条钉住（401/404/200-with-error/非 JSON）。
    // 钉的是"成败判定不碰网络"这一形状，语义与拆之前完全一致——没有放松，只是搬了家。
    const at = ai.indexOf("fn probe_verdict");
    expect(at, "判据不再是独立函数：它又变成只能真机点的黑盒").toBeGreaterThan(-1);
    const v = ai.slice(at, ai.indexOf("\n}", at));
    expect(v.includes("-> Result<String, String>"), "判定表的返回类型退了：Ok 里不再带着凭据").toBe(true);
    expect(/if status >= 400 \{\s*return Err\(classify_error\(status, body\)\)/.test(v), "非 2xx 不再回传上游原文").toBe(true);
    expect(v.includes("upstream_error_text"), "200 里夹着 error 字段这一路不再算失败").toBe(true);
    expect(ai.slice(ai.indexOf("pub async fn ai_probe"), at).includes("probe_verdict(&format, status, &text)"), "命令没有把成败交给判定表").toBe(true);
  });

  it("探针体非流式、不发 temperature（少一个字段少一种假失败）", () => {
    const pb = ai.slice(ai.indexOf("fn probe_body"), ai.indexOf("fn cut_chars"));
    expect(pb.match(/"stream": false/g)?.length, "三种格式都要非流式").toBe(3);
    expect(pb.includes("temperature"), "探针又开始发 temperature 了").toBe(false);
  });

  it("新命令已注册进 invoke_handler（第 10 门同样盯这条，这里钉的是它不在时）", () => {
    expect(readAt(LIB_RS).includes("ai::ai_probe"), "忘了注册：前端每次点都是「命令不存在」").toBe(true);
  });
});

describe("P114-A · 流式那条通道仍然只能用对的方式用", () => {
  it("chatStore 在 await ai_chat 之前先登记 reqId，否则错误事件会被自己的守卫丢掉", () => {
    // 这一条不是新约束，是把"为什么聊天没出这个事"写下来：它先 `snapshot.reqId = reqId`，
    // 成败交给 ai:error / ai:done 事件判定——那是流式命令唯一正确的用法。
    const src = read(CHAT);
    const at = src.indexOf("snapshot.reqId = reqId");
    const invokeAt = src.indexOf('await invoke("ai_chat"');
    expect(at).toBeGreaterThan(-1);
    expect(invokeAt).toBeGreaterThan(-1);
    expect(at < invokeAt, "reqId 登记晚于 invoke：错误事件到时无人对账").toBe(true);
  });
});
