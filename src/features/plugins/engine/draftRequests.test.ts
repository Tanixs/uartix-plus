/**
 * P174-B1：待确认的转正请求表。
 *
 * 这张表是"AI 只能提名、人才能装"的落点，所以钉的不是存储细节，而是三条产品承诺：
 * 同名只留一条、忽略之后真的消失、订阅者能收到变化（否则界面上的卡永远不出现）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDraftPromotions,
  dismissDraftPromotion,
  getDraftRequests,
  queueDraftPromotion,
  subscribeDraftRequests,
  type DraftPromotionRequest,
} from "./draftRequests";

const req = (over: Partial<DraftPromotionRequest> = {}): DraftPromotionRequest => ({
  name: "a.b-v1",
  id: "a.b",
  title: "示例",
  version: "1.0.0",
  permissions: ["写 $WS/runs"],
  verdict: "needs-approval",
  requestedBy: "ai",
  at: 100,
  ...over,
});

beforeEach(() => {
  clearDraftPromotions();
});

describe("转正请求表", () => {
  it("放进去就能读到；快照在没有变化时保持同一引用（useSyncExternalStore 的前提）", () => {
    queueDraftPromotion(req());
    const a = getDraftRequests();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ name: "a.b-v1", requestedBy: "ai" });
    expect(getDraftRequests()).toBe(a);
  });

  it("同名覆盖只留一条，且保留最早的时间（连刷三次不该出现三张卡）", () => {
    queueDraftPromotion(req({ at: 100 }));
    queueDraftPromotion(req({ at: 200, note: "第二次" }));
    queueDraftPromotion(req({ at: 300, note: "第三次" }));
    const all = getDraftRequests();
    expect(all).toHaveLength(1);
    expect(all[0].at).toBe(100);
    expect(all[0].note).toBe("第三次");
  });

  it("按时间排序；忽略只摘掉指定那一份", () => {
    queueDraftPromotion(req({ name: "b-1", at: 200 }));
    queueDraftPromotion(req({ name: "a-1", at: 100 }));
    expect(getDraftRequests().map((r) => r.name)).toEqual(["a-1", "b-1"]);
    dismissDraftPromotion("a-1");
    expect(getDraftRequests().map((r) => r.name)).toEqual(["b-1"]);
    dismissDraftPromotion("不存在");
    expect(getDraftRequests()).toHaveLength(1);
  });

  it("订阅者在入队/忽略/清空时都会收到通知", () => {
    const fn = vi.fn();
    const off = subscribeDraftRequests(fn);
    queueDraftPromotion(req());
    dismissDraftPromotion("a.b-v1");
    queueDraftPromotion(req());
    clearDraftPromotions();
    expect(fn).toHaveBeenCalledTimes(4);
    off();
    queueDraftPromotion(req());
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("快照是冻结的：界面无法从外部把请求表改坏", () => {
    queueDraftPromotion(req());
    const snap = getDraftRequests() as DraftPromotionRequest[];
    expect(() => snap.push(req({ name: "x-1" }))).toThrow();
    expect(() => {
      snap[0].note = "被改了";
    }).toThrow();
  });
});
