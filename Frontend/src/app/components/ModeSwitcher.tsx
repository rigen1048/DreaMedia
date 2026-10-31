import { useEffect, useMemo, useState } from "react";
import { Command, Search } from "lucide-react";
import { appModes, getActiveMode } from "./modes";

type ModeSwitcherProps = {
  location: string;
  closeToken: number;
  onNavigate: (href: string) => void;
  onCloseBell: () => void;
};

export default function ModeSwitcher({
  location,
  closeToken,
  onNavigate,
  onCloseBell,
}: ModeSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const activeMode = getActiveMode(location);
  const options = useMemo(
    () => appModes.filter((mode) => mode.label.toLowerCase().includes(query.toLowerCase())),
    [query],
  );

  const reset = () => {
    setOpen(false);
    setQuery("");
    setSelectedIndex(0);
  };
  const openSwitcher = () => {
    setOpen(true);
    setQuery("");
    setSelectedIndex(0);
    onCloseBell();
  };
  const navigate = (href: string) => {
    reset();
    onNavigate(href);
  };

  useEffect(() => {
    reset();
  }, [closeToken]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) reset();
        else openSwitcher();
        return;
      }
      if (event.key === "Escape") {
        reset();
        onCloseBell();
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      const mode = appModes.find((item) => item.key === event.key);
      if (mode) {
        navigate(mode.href);
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        window.dispatchEvent(new Event("dreamedia:focus-search"));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <>
      <button className="quick-switch-button" onClick={openSwitcher} aria-label="Quick switch">
        <Command size={14} />
        <span>Jump to</span>
        <kbd>⌘/Ctrl K</kbd>
      </button>
      {open && (
        <div
          className="switcher-scrim"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) reset();
          }}
        >
          <section
            className="mode-switcher"
            role="dialog"
            aria-modal="true"
            aria-label="Jump to mode"
          >
            <div className="switcher-search">
              <Search size={16} />
              <input
                autoFocus
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setSelectedIndex(0);
                }}
                placeholder="Go to a mode…"
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setSelectedIndex((index) =>
                      Math.min(index + 1, Math.max(0, options.length - 1)),
                    );
                  }
                  if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setSelectedIndex((index) => Math.max(index - 1, 0));
                  }
                  if (event.key === "Enter" && options[selectedIndex])
                    navigate(options[selectedIndex].href);
                }}
              />
              <kbd>ESC</kbd>
            </div>
            <div className="switcher-label">MODES</div>
            {options.map(({ href, label, key, icon: Icon }, index) => (
              <button
                key={href}
                className={`switcher-option ${activeMode === label ? "current" : ""} ${selectedIndex === index ? "selected" : ""}`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => navigate(href)}
              >
                <Icon size={16} />
                <span>{label}</span>
                {activeMode === label && <small>Current</small>}
                <kbd>{key}</kbd>
              </button>
            ))}
            <div className="switcher-foot">
              <span>↑↓ Select</span>
              <span>↵ Open</span>
              <span>/ Search</span>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
