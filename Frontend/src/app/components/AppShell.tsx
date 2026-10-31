import { useCallback, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { LogOut } from "lucide-react";
import { useMedia } from "../../features/media";
import BackendBell from "./BackendBell";
import ModeNavigation from "./ModeNavigation";
import ModeSwitcher from "./ModeSwitcher";
import { appModes, getActiveMode } from "./modes";

type AppShellProps = {
  children: ReactNode;
};

export default function AppShell({ children }: AppShellProps) {
  const [location, setLocation] = useLocation();
  const [bellCloseToken, setBellCloseToken] = useState(0);
  const [switcherCloseToken, setSwitcherCloseToken] = useState(0);
  const { logout, refresh, syncError } = useMedia();
  const activeMode = getActiveMode(location);
  const navigate = useCallback((href: string) => setLocation(href), [setLocation]);
  const closeBell = useCallback(() => setBellCloseToken((token) => token + 1), []);
  const closeSwitcher = useCallback(() => setSwitcherCloseToken((token) => token + 1), []);

  return (
    <div className="app-frame">
      <header className="topbar mode-topbar">
        <a href="/notifications" className="brand-lockup" aria-label="DreaMedia home">
          <span className="brand-mark">
            <span />
          </span>
          <span className="brand-word">
            drea<span>/</span>media
          </span>
        </a>
        <ModeNavigation activeMode={activeMode} modes={appModes} onNavigate={navigate} />
        <div className="topbar-actions">
          <ModeSwitcher
            location={location}
            closeToken={switcherCloseToken}
            onNavigate={navigate}
            onCloseBell={closeBell}
          />
          <BackendBell closeToken={bellCloseToken} onOpen={closeSwitcher} />
          <button
            className="topbar-avatar"
            aria-label="Sign out"
            title="Sign out"
            onClick={() => void logout()}
          >
            <LogOut size={13} />
          </button>
        </div>
      </header>
      {syncError && (
        <div className="backend-sync-status" role="status">
          <span>Sync paused · {syncError}</span>
          <button onClick={() => void refresh()}>Retry</button>
        </div>
      )}
      <main className="page-canvas">{children}</main>
    </div>
  );
}
