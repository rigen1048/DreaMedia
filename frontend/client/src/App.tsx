import { Route, Switch } from "wouter";
import AppShell from "./components/AppShell";
import ErrorBoundary from "./components/ErrorBoundary";
import { MediaProvider, useMedia } from "./data/MediaContext";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import Management from "./pages/Management";
import Track from "./pages/Track";

function RoutedApp() {
  const { authStatus, authError, refresh } = useMedia();
  if (authStatus === "loading") return <main className="auth-screen"><div className="auth-card"><span className="brand-word">drea<span>/</span>media</span><p>Connecting to backend…</p></div></main>;
  if (authStatus === "unauthenticated") return <Login />;
  if (authStatus === "error") return <main className="auth-screen"><div className="auth-card"><span className="brand-word">drea<span>/</span>media</span><h1>Backend unavailable</h1><p>{authError ?? "Could not connect to the DreaMedia service."}</p><button className="primary-button" onClick={() => void refresh()}>Retry</button><small>Configure the backend and database using the instructions in the monorepo README.</small></div></main>;
  return <AppShell><Switch><Route path="/" component={Dashboard} /><Route path="/notifications" component={Dashboard} /><Route path="/management" component={Management} /><Route path="/track" component={Track} /><Route component={Dashboard} /></Switch></AppShell>;
}

export default function App() {
  return <ErrorBoundary><MediaProvider><RoutedApp /></MediaProvider></ErrorBoundary>;
}
