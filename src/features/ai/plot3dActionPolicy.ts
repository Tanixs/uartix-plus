export function resolvePlot3dGroup(
  args: Record<string, unknown>,
  groups: readonly { id: string }[],
  required = false,
): string {
  const id = args.gid === undefined && !required ? "g1" : args.gid;
  if (typeof id !== "string" || !groups.some((g) => g.id === id)) {
    throw new Error("无效或已删除的轨迹组 ID；请先读取 plot3dRead 获取当前组列表");
  }
  return id;
}

// External action arguments cannot carry trusted local human approval.
export function plot3dRemovalReceipt(gid: string) {
  return { ok: false, status: "needs_manual_confirmation", gid, message: "需人工确认：请在 3D 组行菜单中删除；本次未执行" };
}
