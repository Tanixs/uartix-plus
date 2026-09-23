/**
 * P99c-C1c：停在「等你确认」的装包请求——**覆盖已有版本**才会停在这儿。
 * P99b-N4：它搬到 `App.tsx` 顶层渲染**一份**。
 *
 * 为什么不留在弹窗里：挂在插件库弹窗内时，关掉弹窗这张卡就不存在了，而命令行的
 * `install` 恰恰会说「请在应用里点装入」——于是那条请求在没人看见的地方等满 10 分钟
 * 然后静默作废。发起方在应用外，决定权在人，人却找不到那个"点"的地方。
 *
 * 这里仍然只做三件事：说清会碰到什么、给两个按钮、把结果原话贴回来。
 * **本页不产生任何判定，也不自己数相位**：`text` 全来自内核的 `describePlan`，
 * 列表全来自 `marketPending` 的那三个选择器（`useMarketPending`），
 * 出现具体条目名/作者名或 `phase === ...` 就是 bug（`marketUi.test.ts` 两条反向钉着）。
 */
import { useState } from "react";
import {
  acceptMarketInstall, rejectMarketInstall, type PendingView,
} from "./marketPending";
import { useAwaitingViews, useWorkingViews } from "./useMarketPending";

const BTN_ACCEPT = "装入";
const BTN_REJECT = "不装";
/** 装完不自动启用这句要说一次以上：它是"为什么装完没变化"的唯一答案 */
const NO_AUTO_ENABLE_TIP =
  "装进来是停用态，还要你启用才会生效；这一步不会自动启用，也不会有任何一条命令能替你点这里的按钮。";

export function InstallConfirm() {
  const awaiting = useAwaitingViews();
  const working = useWorkingViews();
  /** 点完「装入/不装」之后那张条不能立刻消失——它一消失，"点了到底有没有反应"就又看不见了 */
  const [note, setNote] = useState<{ ok: boolean; msg: string } | null>(null);
  if (!working.length && !awaiting.length && !note) return null;
  const resolve = (fn: (token: string) => { ok: boolean; msg: string }, v: PendingView) => {
    const r = fn(v.token);
    // 回执必须出声：点了没反应是这批最不能留的那种洞
    setNote({ ok: r.ok, msg: r.msg || (r.ok ? "已处理，本机按上面那条原话变了" : "没处理，本机没动") });
  };
  const onlyNote = !working.length && !awaiting.length;
  return (
    <section className="mkt-pend" aria-label="装包请求">
      {onlyNote ? null : (
        <div className="mkt-pend-head">
          <span className="mkt-pend-count">
            {awaiting.length ? `${awaiting.length} 条装包请求等你确认` : "正在应用里取回与校验…"}
          </span>
          {working.length ? <span className="mkt-pend-sub">{`${working.length} 条在跑`}</span> : null}
        </div>
      )}
      {awaiting.map((v) => (
        <article className="mkt-pend-card" key={v.token} aria-label={v.entryId}>
          <p className="mkt-pend-text">{v.text}</p>
          <div className="mkt-pend-btns">
            <button className="btn primary" title={`确认覆盖本机版本并装入 ${v.entryId}`} onClick={() => resolve(acceptMarketInstall, v)}>
              {BTN_ACCEPT}
            </button>
            <button className="btn" title={`放弃这次请求，本机不动（${v.entryId}）`} onClick={() => resolve(rejectMarketInstall, v)}>
              {BTN_REJECT}
            </button>
            <span className="mkt-pend-token">令牌 {v.token.slice(0, 8)}…</span>
          </div>
        </article>
      ))}
      {working.map((v) => (
        <div className="mkt-pend-run" key={v.token}>
          <span className="plg-chip">{v.phaseText}</span>
          <span className="mkt-pend-id">{v.entryId}</span>
        </div>
      ))}
      {note ? (
        <div className={note.ok ? "mkt-pend-note ok" : "mkt-pend-note err"} role="status">
          {note.msg}
          <button className="btn mkt-pend-close" onClick={() => setNote(null)} title="知道了，收掉这条回执">
            知道了
          </button>
        </div>
      ) : null}
      {onlyNote ? null : <p className="mkt-pend-tip">{NO_AUTO_ENABLE_TIP}</p>}
    </section>
  );
}
