import { Component, type ReactNode } from "react";
import { tx } from "../i18n/strings";

// i18n-subscribe: 类组件用不了 hook。崩溃面是在崩的那一刻按当下语言渲染一次，
// 之后没有人会一边看着崩溃框一边切语言；真切了，下一次崩溃就是新语言。故豁免，不补订阅。
export class ErrorBoundary extends Component<
  {
    children: ReactNode;
    label?: string;
    root?: boolean;
  },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("[ErrorBoundary]", this.props.label ?? "app", error);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    const msg = String(this.state.error?.message ?? this.state.error);
    return (
      <div className={this.props.root ? "crash-box crash-root" : "crash-box"}>
        <div className="crash-title">
          {this.props.root
            ? tx("界面遇到未捕获错误", "The interface hit an uncaught error")
            : tx(`「${this.props.label ?? "此面板"}」崩溃`, `"${this.props.label ?? "This panel"}" crashed`)}
        </div>
        <div className="crash-err">{msg}</div>
        <div className="crash-actions">
          {!this.props.root && (
            <button className="btn" onClick={this.reset}>
              {tx("重载此面板", "Reload this panel")}
            </button>
          )}
          <button className="btn primary" onClick={() => location.reload()}>
            {tx("重启应用", "Restart the app")}
          </button>
        </div>
        {this.props.root && (
          <div className="crash-hint">{tx("串口连接等内核状态不受影响，重启应用后会自动恢复。",
            "Kernel state such as the serial link is unaffected and comes back after a restart.")}</div>
        )}
      </div>
    );
  }
}
