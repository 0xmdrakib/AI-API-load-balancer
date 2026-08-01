import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./styles.css";

class RendererErrorBoundary extends React.Component<React.PropsWithChildren, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, details: React.ErrorInfo) {
    console.error("Renderer recovery boundary", error, details.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="renderer-recovery" role="alert">
        <div className="brand-mark"><img src="/logo.png" alt="" /></div>
        <p className="eyebrow">Interface recovery</p>
        <h1>The dashboard hit a rendering error.</h1>
        <p>The isolated proxy can keep serving requests. Reload the interface to restore the dashboard.</p>
        <button className="primary-button" type="button" onClick={() => window.location.reload()}>Reload dashboard</button>
      </main>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </React.StrictMode>
);
