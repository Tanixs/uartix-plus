import { Component, type ReactNode } from "react";

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
          {this.props.root ? "界面遇到未捕获错误" : `「${this.props.label ?? "此面板"}」崩溃`}
        </div>
        <div className="crash-err">{msg}</div>
        <div className="crash-actions">
          {!this.props.root && (
            <button className="btn" onClick={this.reset}>
              重载此面板
            </button>
          )}
          <button className="btn primary" onClick={() => location.reload()}>
            重启应用
          </button>
        </div>
        {this.props.root && (
          <div className="crash-hint">串口连接等内核状态不受影响，重启应用后会自动恢复。</div>
        )}
      </div>
    );
  }
}
