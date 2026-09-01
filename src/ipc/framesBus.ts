import { onFrames as binOnFrames } from "./binbus";
import type { FramesEventPayload } from "./types";
import { recordIpcLatency } from "./ipcLatency";

/**
 * parser:frames 单点分发总线（底层数据来自二进制 IPC 总线 binbus）。
 *
 * 旧实现有 7 个模块各自 listen("parser:frames")，每批帧都要走 7 次事件回调 +
 * 7 次 payload 遍历；这里只挂 1 个 binbus 订阅，解码一次后同步扇出给各订阅者。
 *
 * 约定：订阅者 handler 必须轻量且同步（只做取数/入队，不 setState 重渲染）；
 * 需要节流/合并的 store（table/plot）内部已有自己的定时器，这里不额外引入异步。
 */

type Handler = (p: FramesEventPayload) => void;

const handlers = new Set<Handler>();
let started: Promise<void> | null = null;

function ensureListening(): Promise<void> {
  if (started) return started;
  started = Promise.resolve().then(() => {
    binOnFrames((p) => {
      recordIpcLatency(p.emitTs ?? 0);
      // 复制一份再遍历：允许 handler 在回调里 unsubscribe 而不破坏迭代
      for (const h of Array.from(handlers)) {
        try {
          h(p);
        } catch (err) {
          console.error("framesBus handler 异常", err);
        }
      }
    });
  });
  return started;
}

/** 订阅帧事件；返回取消订阅函数。首次订阅时惰性建立唯一的 Tauri 监听。 */
export function onFrames(h: Handler): () => void {
  handlers.add(h);
  void ensureListening();
  return () => {
    handlers.delete(h);
  };
}
