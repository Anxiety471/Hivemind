// Connection settings: server URL and optional operator token.
import { useState } from "preact/hooks";
import { api, applySettings, currentSettings } from "../api";
import { connect } from "../live";
import { ErrorNote, PageHeader } from "../ui";

export function SettingsView() {
  const [baseUrl, setBaseUrl] = useState(currentSettings().baseUrl);
  const [token, setToken] = useState(currentSettings().token);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    <div class="page narrow">
      <PageHeader title="Connection" sub="Where this UI finds `hivemind serve`. Saved in this browser only." />
      <div class="card form">
        <label>
          Server URL
          <input class="mono" value={baseUrl} onInput={(e) => setBaseUrl((e.target as HTMLInputElement).value)} />
        </label>
        <label>
          Operator token <span class="muted">(only when `server.token_env` is configured)</span>
          <input type="password" value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value)} />
        </label>
        <p class="muted small">
          Loopback pages (localhost, 127.0.0.1, [::1]) can call the API directly. With authentication enabled, this page's origin must be
          listed in `server.allowed_origins`.
        </p>
        <ErrorNote error={error} />
        {result && <div class="ok-note">{result}</div>}
        <div class="row">
          <button class="primary" onClick={save}>
            Save and reconnect
          </button>
        </div>
      </div>
    </div>
  );
}
