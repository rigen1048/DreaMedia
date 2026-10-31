import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }
  render() {
    if (this.state.hasError)
      return (
        <main className="auth-screen">
          <section className="auth-card error-card">
            <AlertTriangle size={24} />
            <h1>Something went wrong</h1>
            <pre>{this.state.error?.stack}</pre>
            <button className="primary-button" onClick={() => window.location.reload()}>
              <RotateCcw size={14} /> Reload page
            </button>
          </section>
        </main>
      );
    return this.props.children;
  }
}
