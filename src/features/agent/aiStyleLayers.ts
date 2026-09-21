/**
 * P98-M1：AI 在外观上留下的**全部**痕迹 —— 一个口径，供设置页面板与"清除"动作共用。
 *
 * 为什么单独一个模块（而不是塞进 appearanceStore 或 styleScratch）：
 * 用户报的"停用/卸载都撤不回去"，根因是**这两层各自为政、而且都不归插件生命周期管**——
 * `removeProjections()` 只清扩展投影，永远碰不到它们。所以"把 AI 改的东西撤干净"这件事
 * 必须有一个**同时看得见两层**的地方来说真话；放进任意一层里，就又变成第二份真相。
 * 本模块只读不存：它是两层之上的一个聚合出口。
 */
import { clearOverlay, getOverrides, subscribeOverlayChange } from "./appearanceStore";
import { listLayers, revertAll, subscribeScratch } from "./styleScratch";

export interface AiStyleFootprint {
  /** AI token 覆盖层（theme_patch / theme_preset 写的 `--*`） */
  tokens: number;
  tokenNames: string[];
  /** AI 组件样式层（style_patch 写的具名 `<style>` 层） */
  layers: { name: string; bytes: number }[];
  /** 两层都没东西 ⇒ 面板显示"AI 当前没有改动外观" */
  clean: boolean;
}

export function aiStyleFootprint(): AiStyleFootprint {
  const overrides = getOverrides();
  const tokenNames = Object.keys(overrides);
  const layers = listLayers();
  return { tokens: tokenNames.length, tokenNames, layers, clean: !tokenNames.length && !layers.length };
}

/** 订阅两层任一变更；返回退订 */
export function subscribeAiStyle(cb: () => void): () => void {
  const offA = subscribeOverlayChange(cb);
  const offB = subscribeScratch(cb);
  return () => {
    offA();
    offB();
  };
}

/**
 * 清掉 AI 留下的全部外观改动（两层），返回各自清了多少——回执/提示要能说清动了什么。
 * 刻意**不碰**插件主题层与用户自己的外观设置：这一键的语义是"撤掉 AI 动过的"，
 * 不是"把界面恢复出厂"。后者是 `恢复外观默认`，另一颗按钮、另一次确认。
 */
export function clearAiStyleLayers(): { tokens: number; layers: number } {
  const tokens = Object.keys(getOverrides()).length;
  const layers = listLayers().length;
  clearOverlay();
  revertAll();
  return { tokens, layers };
}
