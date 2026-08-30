import ReactDOM from "react-dom/client";
import "dockview-react/dist/styles/dockview.css";
import "./styles/theme.css";
import App from "./App";
import { ErrorBoundary } from "./shared/ErrorBoundary";

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
