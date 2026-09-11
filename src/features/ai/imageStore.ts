/**
 * AI 历史图片 IndexedDB 存储（P51 遗留补全）：
 * - 发送时保存（chatStore.sendText → saveImage），刷新后按 imgIds 恢复（restoreImages）
 * - LRU 上限：条数 300 / 总量 64MB，触顶按 ts 从旧到新淘汰
 * - 纯原生 IndexedDB 零依赖；打开/读写失败一律静默降级（历史无图，不影响聊天主流程）
 *
 * 记录结构：{ id(主键), msgId, ts, bytes, data(data URL) }。
 * id 由调用方写入消息的 imgIds 并随会话持久化到 localStorage（体积小）；
 * 图片本体只存这里，不进 localStorage（容量保护）。
 */

const DB_NAME = "vs-ai-images";
const STORE = "imgs";
/** 上限可配置（设置页「数据」tab）：localStorage 存条数与 MB，越界取默认 */
const LIMIT_COUNT_KEY = "vs.aiImages.max";
const LIMIT_MB_KEY = "vs.aiImages.mb";
const DEF_COUNT = 300;
const DEF_MB = 64;

function limits(): { count: number; bytes: number } {
  let count = DEF_COUNT;
  let mb = DEF_MB;
  try {
    const c = Number(localStorage.getItem(LIMIT_COUNT_KEY));
    const m = Number(localStorage.getItem(LIMIT_MB_KEY));
    if (Number.isFinite(c) && c >= 10 && c <= 5000) count = Math.round(c);
    if (Number.isFinite(m) && m >= 8 && m <= 512) mb = Math.round(m);
  } catch {
    /* 默认 */
  }
  return { count, bytes: mb * 1024 * 1024 };
}

export function setImageLimits(count: number, mb: number): void {
  try {
    localStorage.setItem(LIMIT_COUNT_KEY, String(Math.min(5000, Math.max(10, Math.round(count)))));
    localStorage.setItem(LIMIT_MB_KEY, String(Math.min(512, Math.max(8, Math.round(mb)))));
  } catch {
    /* 存储满：仅默认值 */
  }
  void prune();
}

export interface ImgRec {
  id: string;
  msgId: string;
  ts: number;
  bytes: number;
  data: string;
}

let dbp: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) {
            const st = db.createObjectStore(STORE, { keyPath: "id" });
            st.createIndex("msgId", "msgId", { unique: false });
            st.createIndex("ts", "ts", { unique: false });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
        req.onblocked = () => reject(new Error("IndexedDB open blocked"));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
    // 打开失败后置空，下次调用允许重试
    dbp.catch(() => {
      dbp = null;
    });
  }
  return dbp;
}

/** 单事务执行：fn 返回 IDBRequest 时自动取其结果 */
function tx<T>(
  mode: IDBTransactionMode,
  fn: (st: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        let t: IDBTransaction;
        try {
          t = db.transaction(STORE, mode);
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
          return;
        }
        const st = t.objectStore(STORE);
        let out: T | undefined;
        const r = fn(st);
        if (r) {
          r.onsuccess = () => {
            out = r.result;
          };
        }
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error ?? new Error("IndexedDB tx failed"));
        t.onabort = () => reject(t.error ?? new Error("IndexedDB tx aborted"));
      }),
  );
}

/** 保存一张图片（发送时调用），返回记录 id（写入消息 imgIds 用）。失败抛错由调用方降级。 */
export async function saveImage(msgId: string, data: string): Promise<string> {
  const rec: ImgRec = { id: crypto.randomUUID(), msgId, ts: Date.now(), bytes: data.length, data };
  await tx("readwrite", (st) => {
    st.put(rec);
  });
  void prune();
  return rec.id;
}

/** LRU 淘汰：条数或字节超限时按 ts 从旧到新删，直到回到限内 */
async function prune(): Promise<void> {
  try {
    const { count: MAX_COUNT, bytes: MAX_BYTES } = limits();
    const all = await tx<ImgRec[]>("readonly", (st) => st.getAll() as IDBRequest<ImgRec[]>);
    if (!all) return;
    let n = all.length;
    let bytes = all.reduce((a, r) => a + r.bytes, 0);
    if (n <= MAX_COUNT && bytes <= MAX_BYTES) return;
    const oldest = [...all].sort((a, b) => a.ts - b.ts);
    const kill: string[] = [];
    for (const r of oldest) {
      if (n <= MAX_COUNT && bytes <= MAX_BYTES) break;
      kill.push(r.id);
      n -= 1;
      bytes -= r.bytes;
    }
    await tx("readwrite", (st) => {
      for (const id of kill) st.delete(id);
    });
  } catch {
    /* 降级：不 prune 也能继续用 */
  }
}

/** 按消息的 imgIds 顺序恢复图片数据；失败的 id 跳过（不阻塞其余） */
export async function restoreImages(ids: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    try {
      const rec = await tx<ImgRec | undefined>(
        "readonly",
        (st) => st.get(id) as IDBRequest<ImgRec | undefined>,
      );
      if (rec?.data) out.push(rec.data);
    } catch {
      /* 单条失败跳过 */
    }
  }
  return out;
}

/** 删除图片记录（删消息/删会话时清理；尽力而为） */
export async function deleteImages(ids: string[]): Promise<void> {
  if (!ids.length) return;
  try {
    await tx("readwrite", (st) => {
      for (const id of ids) st.delete(id);
    });
  } catch {
    /* 忽略 */
  }
}

/** 存储占用统计（设置页展示）；失败返回 null（无 IDB 环境/降级） */
export async function imageStoreStats(): Promise<{ count: number; bytes: number } | null> {
  try {
    const all = await tx<ImgRec[]>("readonly", (st) => st.getAll() as IDBRequest<ImgRec[]>);
    if (!all) return { count: 0, bytes: 0 };
    return { count: all.length, bytes: all.reduce((a, r) => a + r.bytes, 0) };
  } catch {
    return null;
  }
}

/** 一键清空全部图片缓存（设置页；聊天消息里的图刷新后将不再恢复） */
export async function clearAllImages(): Promise<void> {
  try {
    await tx("readwrite", (st) => {
      st.clear();
    });
  } catch {
    /* 忽略 */
  }
}
