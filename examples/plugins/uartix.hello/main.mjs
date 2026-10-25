/**
 * 示例扩展：除了日志，它还带一个自己的面板（`panel.html`）。
 *
 * 面板与这个进程的关系只有一条线：
 *   面板里的 `uartix.call("ping", …)`  →  宿主转发 `panel.hello.ping`  →  下面的 `ping()`
 * 反过来是：
 *   `ctx.panels.emit("hello", "heartbeat", …)`  →  宿主  →  面板里的 `uartix.on("heartbeat", …)`
 *
 * 刻意不做的事：不去碰文件系统、不起子进程。**能跑起来的最小集合本来就不需要特权**，
 * 这样装的时候只有一条"在界面里加面板"要批准——那也正是它真正要做的事。
 */
let timer = null;
let beats = 0;

export async function activate(ctx) {
  ctx.log.info(`示例扩展已启动；工作区 = ${ctx.workspace || "(未配置)"}`);

  // 面板能调的方法。前缀 `panel.<panelId>.` 由宿主拼好，这里只写方法名。
  ctx.panels.register("hello", {
    async ping(args) {
      return { pong: true, at: new Date().toISOString(), echo: args ?? null, beats };
    },
    async stats() {
      return { beats, pid: process.pid, node: process.version };
    },
  });

  timer = setInterval(() => {
    beats += 1;
    ctx.log.info(`心跳 ${beats}`);
    // 日志之外再推一条事件：面板上的数字靠它跳动，而不是靠轮询
    ctx.panels.emit("hello", "heartbeat", { beats, at: Date.now() });
  }, 2000);

  ctx.onDispose(() => {
    if (timer) clearInterval(timer);
    timer = null;
    ctx.log.info(`已停止：共 ${beats} 次心跳`);
  });
}
