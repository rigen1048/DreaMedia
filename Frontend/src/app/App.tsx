import { Route, Switch } from "wouter";
import Management from "../features/management/Management";
import Notifications from "../features/notifications/Notifications";
import Todo from "../features/todo/Todo";
import Login from "../features/auth/Login";
import { AppProvider, useApp } from "./state";
import Shell from "./Shell";

function Gate() {
  const { viewer, loading, authError, refresh } = useApp();

  if (loading) {
    return (
      <div className="auth-splash">
        <div>
          <div className="mark">d/</div>
          <div style={{ color: "var(--dim)", fontSize: 12 }}>Connecting to the backend…</div>
        </div>
      </div>
    );
  }

  if (authError) {
    return (
      <div className="auth-splash">
        <div style={{ maxWidth: 380, display: "grid", gap: 10, justifyItems: "center" }}>
          <div className="mark">d/</div>
          <h2 style={{ fontSize: 18 }}>Backend unavailable</h2>
          <p style={{ color: "var(--faint)", fontSize: 12.5 }}>{authError}</p>
          <button className="btn" onClick={() => void refresh()}>
            Retry connection
          </button>
        </div>
      </div>
    );
  }

  if (!viewer) return <Login />;

  return (
    <Shell>
      <Switch>
        <Route path="/" component={Notifications} />
        <Route path="/notifications" component={Notifications} />
        <Route path="/sources" component={Management} />
        <Route path="/management" component={Management} />
        <Route path="/todo" component={Todo} />
        <Route path="/track" component={Todo} />
        <Route component={Notifications} />
      </Switch>
    </Shell>
  );
}

export default function App() {
  return (
    <AppProvider>
      <Gate />
    </AppProvider>
  );
}
