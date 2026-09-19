// §8: a render error anywhere took the whole app to a blank white page with no
// message — on a monitoring product that is indistinguishable from the server
// being down. React only recovers from a render error through a class
// component, so this is the one class in the codebase.
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Reset when this changes (the route path), so navigating away recovers. */
  resetKey?: string;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the stack in the console: this replaces React's own default, and a
    // support call starts with "what does the console say".
    console.error("Unhandled render error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    // Deliberately not translated and deliberately dependency-free: the
    // dictionary or a provider may be exactly what failed.
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-xl font-semibold text-foreground">Something went wrong on this page</h1>
        <p className="max-w-lg text-sm text-muted-foreground">
          The rest of the application is still running. Reload, or go back and try again.
        </p>
        <pre className="max-w-full overflow-x-auto rounded bg-muted p-3 text-left text-xs text-muted-foreground">
          {this.state.error.message}
        </pre>
        <button
          className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted/40"
          onClick={() => this.setState({ error: null })}
        >
          Try again
        </button>
      </div>
    );
  }
}
