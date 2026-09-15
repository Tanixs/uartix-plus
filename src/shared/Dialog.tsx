/**
 * 主题跟随的确认/提示弹窗（P82⑤）：替换全库原生 alert/confirm——原生弹窗不吃主题、
 * 阻塞主线程、按钮文案不可本地化。命令式 API + 串行队列（一次只开一个，后到的排队）；
 * 弹层 portal 到 body（红线 20）；Enter=确认、Esc/遮罩=取消；焦点自动落在主按钮。
 */
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { tx } from "../i18n/strings";

export interface DialogOpts {
  title?: string;
  message: string;
  okLabel?: string;
  cancelLabel?: string;
  /** 破坏性操作：确认按钮红标 */
  danger?: boolean;
  /** 内部：提示框（单按钮，无取消） */
  alertMode?: boolean;
}

function norm(o: string | DialogOpts): DialogOpts {
  return typeof o === "string" ? { message: o } : o;
}

let queue: Promise<unknown> = Promise.resolve();

function showOne(o: DialogOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const done = (ok: boolean) => {
      root.unmount();
      host.remove();
      resolve(ok);
    };
    root.render(<DialogBox {...o} onDone={done} />);
  });
}

function enqueue(o: DialogOpts): Promise<boolean> {
  const task = queue.then(() => showOne(o));
  queue = task.catch(() => false);
  return task;
}

/** 确认框：Enter/点「确认」= true；Esc/遮罩/点「取消」= false */
export function confirmDialog(o: string | DialogOpts): Promise<boolean> {
  return enqueue(norm(o));
}

/** 提示框：单按钮关闭（知道了） */
export function alertDialog(o: string | DialogOpts): Promise<void> {
  const x = norm(o);
  return enqueue({ ...x, alertMode: true, okLabel: x.okLabel ?? tx("知道了", "OK") }).then(
    () => undefined,
  );
}

// 命令式弹窗 = 非组件导出 + 内部组件的固有形态（同 icons.tsx），fast refresh 对本文件不适用
// eslint-disable-next-line react-refresh/only-export-components
function DialogBox(o: DialogOpts & { onDone: (ok: boolean) => void }) {
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    okRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        o.onDone(false);
      } else if (e.key === "Enter") {
        e.stopPropagation();
        o.onDone(true);
      }
    };
    window.addEventListener("keydown", key, true);
    return () => window.removeEventListener("keydown", key, true);
  });
  const isAlert = o.alertMode === true;
  return (
    <div className="modal-mask" role="dialog" aria-modal="true" onMouseDown={() => o.onDone(false)}>
      <div className="modal app-dlg" onMouseDown={(e) => e.stopPropagation()}>
        {o.title && <div className="modal-title">{o.title}</div>}
        <div className="app-dlg-msg">{o.message}</div>
        <div className="app-dlg-actions">
          {!isAlert && (
            <button className="btn" onClick={() => o.onDone(false)}>
              {o.cancelLabel ?? tx("取消", "Cancel")}
            </button>
          )}
          <button
            ref={okRef}
            className={`btn ${o.danger ? "danger" : "primary"}`}
            onClick={() => o.onDone(true)}
          >
            {o.okLabel ?? tx("确认", "Confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
