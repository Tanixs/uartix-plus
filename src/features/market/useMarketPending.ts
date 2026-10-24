/**
 * P99b-N4：把 `marketPending` 那张表接到 React 上——**这里只有订阅，没有判定**。
 *
 * 为什么单独一个文件：卡片、确认卡、两处入口徽标都要读同一张表。判定一份在
 * `marketPending`（哪几条在等你），格子一份在 `marketBrowse`（这一格写什么），
 * 这里再 filter 一次就是第三份真相（§8-48 同族）。`useSyncExternalStore` 要的
 * "同一引用直到变化"由那两边自己的缓存提供，本文件不造新数组。
 */
import { useSyncExternalStore } from "react";
import {
  awaitingMarketInstalls, liveMarketInstalls, marketPendingSnapshot, subscribeMarketPending, workingMarketInstalls,
  type PendingView,
} from "./marketPending";

/** 整表（卡片拿自己的 id 去查那一枚；顺序＝发起顺序，同一 id 重排过看到的是最新那枚） */
export function usePendingViews(): PendingView[] {
  return useSyncExternalStore(subscribeMarketPending, marketPendingSnapshot, marketPendingSnapshot);
}

/** 等你确认的那几条——确认卡与「全部更新」跳过重复排队都读它 */
export function useAwaitingViews(): PendingView[] {
  return useSyncExternalStore(subscribeMarketPending, awaitingMarketInstalls, awaitingMarketInstalls);
}

/** 正在应用里跑的那几条（横幅出声用） */
export function useWorkingViews(): PendingView[] {
  return useSyncExternalStore(subscribeMarketPending, workingMarketInstalls, workingMarketInstalls);
}

/** 还没到终态的那几条（在飞 + 等你）。「全部更新」按它跳过重复排队 */
export function useLiveViews(): PendingView[] {
  return useSyncExternalStore(subscribeMarketPending, liveMarketInstalls, liveMarketInstalls);
}

/**
 * 入口徽标那个数字：只数「等你确认」。
 * 正在跑的不算——那是它自己在干活，催你去做一件你做不了的事比不催更坏。
 */
export function useAwaitingCount(): number {
  return useSyncExternalStore(subscribeMarketPending, awaitingCount, awaitingCount);
}

function awaitingCount(): number {
  return awaitingMarketInstalls().length;
}
