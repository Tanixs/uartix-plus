/**
 * Operator 只读锁（P67）：独立零业务依赖模块，避免 store ↔ operatorStore 循环引用。
 * 各 store 的可变函数在改动前调用 guardLocked()（锁定时 toast 提示并让调用方直接返回）；
 * operatorStore 负责置位/复位（应用部署包数据期间临时解锁）。
 */

let locked = false;

export function isOperatorLocked(): boolean {
  return locked;
}

export function setOperatorLocked(v: boolean): void {
  locked = v;
}

let toastHost: HTMLDivElement | null = null;

function toast(msg: string) {
  if (typeof document === "undefined") return; // 非 DOM 环境（单测）静默
  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "ai-toast-host";
    document.body.appendChild(toastHost);
  }
  const el = document.createElement("div");
  el.className = "ai-toast";
  el.textContent = msg.slice(0, 200);
  toastHost.appendChild(el);
  window.setTimeout(() => el.remove(), 2600);
}

/** 可变函数入口守卫：锁定时提示并返回 true，调用方 `if (guardLocked()) return;` */
export function guardLocked(): boolean {
  if (!locked) return false;
  toast("Operator 模式：配置只读，退出后才能编辑");
  return true;
}
