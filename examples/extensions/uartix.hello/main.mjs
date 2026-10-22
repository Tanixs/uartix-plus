/**
 * 最小可用的扩展：不申请任何权限，只要一件事——**证明宿主真的把它跑起来了**。
 *
 * 三件刻意做出来的事：
 * 1. `ctx.workspace` 打出来（空说明没配工作区，那也是有用信息）；
 * 2. 每 2 秒一条心跳：日志"一行行出现"是宿主 stdout 逐行读、逐行推的最好证据，
 *    握手成功但定时器没跑，是完全可能的（`setInterval` 被挡、stdout 被别的东西占住）；
 * 3. `onDispose` 里报自己数到的次数：**面板关掉之后**还能看到这一行，才说明 disposer 真跑了。
 *
 * 这里没有权限，所以装的时候不会弹批准卡——**能跑起来的最小集合本来就不需要特权**。
 */
let timer = null;
let beats = 0;

export async function activate(ctx) {
  ctx.log.info(`示例扩展已启动；工作区 = ${ctx.workspace || "(未配置)"}`);
  ctx.log.info(`Node ${process.version}；面板能力 ${ctx.panels ? "可用" : "不可用"}`);
  timer = setInterval(() => {
    beats += 1;
    ctx.log.info(`心跳 ${beats}`);
  }, 2000);
  ctx.onDispose(() => {
    if (timer) clearInterval(timer);
    timer = null;
    ctx.log.info(`已停止：共 ${beats} 次心跳`);
  });
}
