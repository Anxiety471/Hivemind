// Settings: appearance, connection (server URL and optional operator token), and shortcuts.
import { useState } from "react";
import { api, applySettings, currentSettings } from "../api";
import { connect, useLiveStatus } from "../live";
import { useTheme, type Theme } from "../theme";
import { ErrorNote, Kbd, Section, TopBar } from "../ui";

const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function SettingsView() {
  const [baseUrl, setBaseUrl] = useState(currentSettings().baseUrl);
  const [token, setToken] = useState(currentSettings().token);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useTheme();
  const live = useLiveStatus();

  const save = async () => {
    applySettings({ baseUrl: baseUrl.trim(), token: token.trim() });
    connect();
    try {
      const info = await api.info();
      setResult(`Connected to ${info.name} ${info.version} (API ${info.api_version}).`);
      setError(null);
    } catch (e) {
      setResult(null);
      setError((e as Error).message);
    }
  };

  return (
    <div className="view">
      <TopBar icon="settings" title="Settings" />
      <div className="view-body settings-body">
        <Section title="Appearance" description="Saved in this browser.">
          <div className="setting-row">
            <div>
              <div className="setting-label">Theme</div>
              <div className="muted small">Follow the system or pick one.</div>
            </div>
            <div className="theme-picker" role="radiogroup" aria-label="Theme">
              {THEMES.map((t) => (
                <button key={t.value} type="button" role="radio" aria-checked={theme === t.value} className={theme === t.value ? "theme-option on" : "theme-option"} onClick={() => setTheme(t.value)}>
                  <span className={`theme-swatch sw-${t.value}`} />
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </Section>

        <Section
          title="Connection"
          description={
            <>
              Where this UI finds <code>hivemind serve</code>. Saved in this browser only.
            </>
          }
        >
          <div className="panel form">
            <div className="conn-state" data-status={live}>
              <span className="dot" /> {live === "open" ? "Connected" : live === "connecting" ? "Connecting…" : "Offline"}
            </div>
            <label>
              Server URL
              <input className="mono" value={baseUrl} onChange={(e) => setBaseUrl((e.target as HTMLInputElement).value)} />
            </label>
            <label>
              Operator token <span className="muted">(only when `server.token_env` is configured)</span>
              <input type="password" value={token} onChange={(e) => setToken((e.target as HTMLInputElement).value)} />
            </label>
            <p className="muted small">
              Loopback pages (localhost, 127.0.0.1, [::1]) can call the API directly. With authentication enabled, this page's origin must be listed in
              `server.allowed_origins`.
            </p>
            <ErrorNote error={error} />
            {result && <div className="ok-note">{result}</div>}
            <div className="row">
              <button className="primary" onClick={save}>
                Save and reconnect
              </button>
            </div>
          </div>
        </Section>

        <Section title="Keyboard" description="Hivemind is built to be driven from the keyboard.">
          <div className="setting-row">
            <span>Command menu</span>
            <span>
              <Kbd>⌘</Kbd>/<Kbd>Ctrl</Kbd> <Kbd>K</Kbd>
            </span>
          </div>
          <div className="setting-row">
            <span>All shortcuts</span>
            <Kbd>?</Kbd>
          </div>
        </Section>
      </div>
    </div>
  );
}
