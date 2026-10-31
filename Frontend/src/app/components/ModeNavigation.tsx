import type { AppMode, AppModeDefinition } from "./modes";

type ModeNavigationProps = {
  activeMode: AppMode;
  modes: AppModeDefinition[];
  onNavigate: (href: string) => void;
};

export default function ModeNavigation({ activeMode, modes, onNavigate }: ModeNavigationProps) {
  return (
    <nav className="mode-nav" aria-label="Main modes">
      {modes.map(({ href, label, key, icon: Icon }) => (
        <button
          key={href}
          className={`mode-nav-item ${activeMode === label ? "active" : ""}`}
          onClick={() => onNavigate(href)}
          aria-current={activeMode === label ? "page" : undefined}
        >
          <Icon size={15} strokeWidth={1.8} />
          <span>{label}</span>
          <kbd>{key}</kbd>
        </button>
      ))}
    </nav>
  );
}
