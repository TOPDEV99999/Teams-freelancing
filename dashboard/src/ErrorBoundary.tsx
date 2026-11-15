import { Component, type ReactNode } from "react";

/** Shows the error instead of a blank page if any part of the dashboard crashes while rendering. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) { return { error }; }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error("Dashboard crashed:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="mx-auto max-w-3xl p-6">
        <div className="card space-y-3 border-t-4 border-t-rose-500 p-5">
          <h1 className="text-lg font-semibold text-rose-700">The dashboard hit an error</h1>
          <p className="text-sm text-slate-600">Your data is safe. Take a screenshot of this box, then click Reload.</p>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 font-mono text-xs text-slate-800">
            {`${error.name}: ${error.message}\n\n${(error.stack ?? "").split("\n").slice(0, 8).join("\n")}\n\npage: ${location.hash}`}
          </pre>
          <div className="flex gap-2">
            <button className="btn-primary" onClick={() => location.reload()}>Reload</button>
            <button className="btn-ghost" onClick={() => this.setState({ error: null })}>Try to continue</button>
          </div>
        </div>
      </div>
    );
  }
}
