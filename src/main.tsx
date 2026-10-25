import ReactDOM from "react-dom/client";
import "dockview-react/dist/styles/dockview.css";
// uPlot 基础样式：全库唯一入口（画布撑开规则全在库内 CSS，缺它则任何 uPlot 面板图区塌缩为空）。
// 严禁各面板自行局部导入——P75 频谱面板空白即「新面板漏导入」所致。
import "uplot/dist/uPlot.min.css";
import "./styles/theme.css";

/**
 * 旧插件系统与旧 AI 造物已经整体删除，不再兼容。它们在 localStorage 里留的键
 * 没有任何读取者，留着只会让下一次“我明明删了”的排查多绕一圈，所以在启动时清一次。
 * 只碰这四个旧键，不动任何现役数据（会话、设置、插件子系统自己的存储都在别的键/目录里）。
 */
try {
  for (const k of ["vs.pluginLib.v1", "vs.aiExts", "vs.aiWidgets", "vs.aiTheme", "uartix.market.fav.v1"]) {
    localStorage.removeItem(k);
  }
} catch { /* 隐私模式/配额受限：清不掉不影响启动 */ }

if (location.hash === "#/sentinel-widget") {
  // 哨兵桌面挂件窗（P62-S2）：同样独立轻量根
  void import("./features/sentinel/SentinelWidget").then(({ SentinelWidget }) => {
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <SentinelWidget />,
    );
  });
} else {
  // P104-B0：dev-only 取证入口（?preset=&theme=&zoom=&welcome=0&tour=N&layout=keep）。
  // 必须**链在 App 之前**：布局在 dockview onReady 时就定了，覆盖晚到一步 preset 就成了哑参数。
  // 生产构建由 devBootEnabled() 整段短路，详见 src/dev/bootOverrides.test.ts。
  const devBoot: Promise<unknown> = import.meta.env.DEV
    ? import("./dev/bootOverrides").then(({ applyDevBoot }) => {
        const o = applyDevBoot(location.search);
        if (o.preset || o.theme || o.zoom || o.lang || o.tourAt !== undefined || o.welcomeOff || o.welcomeForce)
          console.info("[dev-boot] overrides applied", o);
      })
    : Promise.resolve();

  // P104-B1：缩放必须在挂载 App **之前**落到 DOM。
  // React 里子组件 effect 先于父组件，dockview 的 onReady（算默认布局、读 logicalViewport()）
  // 会跑在 App 那个写 style.zoom 的 useEffect 之前 —— 实测存了 125% 时首次布局仍按 100% 算
  // （templates 得 330 而非 264）。App 内的 effect 只负责后续改动。
  void devBoot
    .then(async () => {
      const [{ getSnapshot }, { applyUiZoom }] = await Promise.all([
        import("./features/settings/settingsStore"),
        import("./shared/zoom"),
      ]);
      applyUiZoom(getSnapshot().zoom);
    })
    .then(() => import("./App"))
    .then(({ default: App }) => {
      void import("./shared/ErrorBoundary").then(({ ErrorBoundary }) => {
        // 注意：本项目刻意不使用 React.StrictMode。
        // 开发模式下 StrictMode 会双重执行 effect，而控制台/serialStore 依赖命令式事件
        // 监听器（listen().then(unlisten)），双重执行会导致每个数据包显示两次。

        // 全局错误捕获：未处理异常/Promise 拒绝打到控制台，便于崩溃排查
        window.addEventListener("error", (e) => {
          console.error("[global]", e.message, e.filename, e.lineno);
        });
        window.addEventListener("unhandledrejection", (e) => {
          console.error("[unhandled-rejection]", e.reason);
        });

        ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
          <ErrorBoundary root>
            <App />
          </ErrorBoundary>,
        );
      });
    });
}
