import ReactDOM from "react-dom/client";
import "dockview-react/dist/styles/dockview.css";
import "./styles/theme.css";
import App from "./App";
import { ErrorBoundary } from "./shared/ErrorBoundary";

// 注意：本项目刻意不使用 React.StrictMode。
// 开发模式下 StrictMode 会双重执行 effect，而控制台/serialStore 依赖命令式事件
// 监听器（listen().then(unlisten)），双重执行会导致每个数据包显示两次。

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary root>
    <App />
  </ErrorBoundary>,
);
