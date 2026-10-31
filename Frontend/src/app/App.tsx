import { Route, Switch } from "wouter";
import { MediaProvider, useMedia } from "../features/media";
import LoginPage from "../features/auth/LoginPage";
import ManagementPage from "../features/management/ManagementPage";
import NotificationsPage from "../features/notifications/NotificationsPage";
import TrackPage from "../features/todo/TrackPage";
import ErrorBoundary from "../shared/ui/ErrorBoundary";
import AppShell from "./components/AppShell";

function AuthenticatedApp() {
  const { authStatus, authError, refresh } = useMedia();

  if (authStatus === "loading") {
    return (
      <main className="auth-screen">
        <div className="auth-card">
          <span className="brand-word">
            drea<span>/</span>media
          </span>
          <p>Connecting to backend…</p>
        </div>
      </main>
    );
  }

  if (authStatus === "unauthenticated") return <LoginPage />;

  if (authStatus === "error") {
    return (
      <main className="auth-screen">
        <div className="auth-card">
          <span className="brand-word">
            drea<span>/</span>media
          </span>
          <h1>Backend unavailable</h1>
          <p>{authError ?? "Could not connect to the DreaMedia service."}</p>
          <button className="primary-button" onClick={() => void refresh()}>
            Retry
          </button>
          <small>Start the backend and database using the monorepo README instructions.</small>
        </div>
      </main>
    );
  }

  return (
    <AppShell>
      <Switch>
        <Route path="/" component={NotificationsPage} />
        <Route path="/notifications" component={NotificationsPage} />
        <Route path="/management" component={ManagementPage} />
        <Route path="/track" component={TrackPage} />
        <Route component={NotificationsPage} />
      </Switch>
    </AppShell>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <MediaProvider>
        <AuthenticatedApp />
      </MediaProvider>
    </ErrorBoundary>
  );
}
