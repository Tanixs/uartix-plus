/**
 * P174-A18①：**可逆 Effect 作用域**——插件/AI 造出来的东西，注册那一刻就拿到自己的撤销凭证。
 *
 * 为什么需要它（dsh 的 Effect 模式，我们照搬到自己的语境）：
 * 现在的"卸载"是靠**逐个文件手写清理**：面板 iframe 随条目消失而消失、子进程靠 `stop()`、
 * 主题靠 `applyStyleExts` 重画一次。这三条能对上，是因为副作用只有这三种。
 * 一旦 AI 能造**桌宠**（透明浮层 + 动画循环 + 系统通知监听）、**小部件**（定时轮询 + 拖拽位置落盘），
 * 手写清理必然漏：漏掉的那一半不会报错，只会让"卸载后 CPU 还在转"。
 *
 * 所以规矩只有一条：**新增任何副作用，必须在这里登记**。撤销时**逆序**执行——
 * 后建的依赖先建的东西（先解绑事件再销毁窗口，先停循环再移除 DOM）。
 *
 * 三条刻意的不宽松：
 * 1. `disposeAll()` 之后 `add()` **抛错**。允许往已销毁的 scope 里加东西，等于把泄漏变成静默；
 * 2. 单个 disposer 抛错**不中断**其余撤销（一条坏掉的清理不该让另外九条不被执行），
 *    错误收集起来一次性抛出；
 * 3. 每个 disposer **只跑一次**（`add()` 返回的释放函数可重复调用，也防 disposeAll 重入）。
 */

export type Disposer = () => void | Promise<void>;

export interface EffectScope {
  /** 作用域名（`plugin:uartix.yolo` / `pet:xxx`），只用于错误信息与调试。 */
  readonly name: string;
  /** 还活着的副作用条数。 */
  readonly size: number;
  /**
   * 登记一条副作用，返回**只撤销这一条**的函数（可重复调用）。
   * `label` 会出现在错误信息里——撤销失败时最想知道的就是"是哪一条"。
   */
  add(label: string, dispose: Disposer): () => void;
  /** 逆序撤销全部。重复调用是安全的；返回的错误数（如果有）。 */
  disposeAll(): Promise<{ failed: number }>;
  readonly disposed: boolean;
}

interface Slot {
  label: string;
  dispose: Disposer;
  done: boolean;
}

export function createScope(name: string): EffectScope {
  const slots: Slot[] = [];
  let disposed = false;

  const runOne = async (slot: Slot): Promise<boolean> => {
    if (slot.done) return true;
    slot.done = true;
    try {
      await slot.dispose();
      return true;
    } catch {
      return false;
    }
  };

  return {
    name,
    get size() {
      return slots.filter((s) => !s.done).length;
    },
    get disposed() {
      return disposed;
    },
    add(label: string, dispose: Disposer): () => void {
      if (disposed) {
        // 扔出去，别静默收下：这条副作用从此没有任何人能撤销
        throw new Error(`作用域「${name}」已经销毁，不能再登记「${label}」`);
      }
      const slot: Slot = { label: String(label || "effect"), dispose, done: false };
      slots.push(slot);
      return () => {
        // 手动提前释放不算错误（幂等），但要从表里摘掉以免 disposeAll 再跑一遍
        void runOne(slot);
      };
    },
    async disposeAll(): Promise<{ failed: number }> {
      if (disposed) return { failed: 0 };
      disposed = true;
      let failed = 0;
      // 逆序：后建的先撤
      for (let i = slots.length - 1; i >= 0; i--) {
        if (!(await runOne(slots[i]))) failed++;
      }
      return { failed };
    },
  };
}
