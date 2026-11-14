/**
 * 控制台「注记」总线（S4）。
 *
 * 为什么不是 `script:log`：那条是脚本运行时的日志，控制台会统一加 `[脚本]` 前缀；
 * 发送拦截不是脚本说的，混进去会指错来源。这里只做一件事：把一条已经拼好的
 * 文本送到控制台日志区（TX/RX 之外的一行注记），零依赖、可在单测里直接触发。
 * 没有订阅者（控制台没开）时静默丢弃——拦截记录不靠这一条留住，见 `preflight.ts`
 * 的环形缓冲。
 */

type NoteListener = (text: string) => void;

const listeners = new Set<NoteListener>();

export function onNote(cb: NoteListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function note(text: string): void {
  for (const cb of Array.from(listeners)) {
    try {
      cb(text);
    } catch {
      // 一条注记失败不能影响发送路径上的其它订阅者
    }
  }
}
