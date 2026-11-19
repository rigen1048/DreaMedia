import { Route, Switch } from "wouter";
import Management from "../features/management/Management";
import Notifications from "../features/notifications/Notifications";
import Todo from "../features/todo/Todo";
import Admin from "../features/admin/Admin";
import Login from "../features/auth/Login";
import { AppProvider, useApp } from "./state";
import Shell from "./Shell";
import { Button } from "@/components/ui/button";

function AdminGate() {
  const { viewer } = useApp();
  // Hiding the nav item is not authorisation; the backend re-checks the role
  // on every admin field. This only keeps a stale URL from showing an empty
  // page to a normal user.
  if (viewer?.role !== "admin") return <Notifications />;
  return <Admin />;
}

function Gate() {
  const { viewer, loading, authError, refresh } = useApp();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <div className="text-2xl font-bold">d<span className="text-muted-foreground">/</span></div>
          <div className="mt-2 text-xs text-muted-foreground">Connecting to the backend…</div>
        </div>
      </div>
    );
  }

  if (authError) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="grid max-w-sm justify-items-center gap-3 text-center">
          <div className="text-2xl font-bold">d<span className="text-muted-foreground">/</span></div>
          <h2 className="text-lg font-semibold">Backend unavailable</h2>
          <p className="text-sm text-muted-foreground">{authError}</p>
          <Button onClick={() => void refresh()}>Retry connection</Button>
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
        <Route path="/admin" component={AdminGate} />
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
