/**
 * Operator 只读锁（P67）：独立零业务依赖模块，避免 store ↔ operatorStore 循环引用。
 * 各 store 的可变函数在改动前调用 guardLocked()（锁定时 toast 提示并让调用方直接返回）；
 * operatorStore 负责置位/复位（应用部署包数据期间临时解锁）。
 */

// P131-A：提示条搬到 shared/toast.ts —— 这里原来是一份**独立的手搓实现**，与
// `ai/extRuntime.toast()` 共用同一对类名却各记各的 host（同一屏可以挂两个提示列），
// 而那对类名在 CSS 里一条规则都没有。shared/toast 是零业务依赖的叶子（它不 import 本模块
// 可能拉进来的任何东西），所以上面那条"独立零业务依赖"的红线仍然成立。
import { toast } from "../../shared/toast";

let locked = false;

export function isOperatorLocked(): boolean {
  return locked;
}

export function setOperatorLocked(v: boolean): void {
  locked = v;
}

/** 可变函数入口守卫：锁定时提示并返回 true，调用方 `if (guardLocked()) return;` */
export function guardLocked(): boolean {
  if (!locked) return false;
  toast("Operator 模式：配置只读，退出后才能编辑");
  return true;
}
