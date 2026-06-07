import { Component, type ReactNode } from "react";
import { createLogger } from "@renderer/logger";

const log = createLogger("boundary");

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
}

/** 组件树崩溃兜底：上报日志 + 极简 fallback（刷新重试）。class 组件——React 仍无函数式 boundary */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: { componentStack?: string | null }): void {
    log.error(
      `component tree crashed${info.componentStack ? `\n${info.componentStack}` : ""}`,
      error,
    );
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 font-sans">
          <p className="text-lg font-medium">Something went wrong.</p>
          <button
            type="button"
            className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
