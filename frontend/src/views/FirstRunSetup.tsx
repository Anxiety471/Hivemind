import { useState } from "react";
import { api, applySettings, currentSettings, type SetupPersona } from "../api";
import { connect } from "../live";

type Runtime = SetupPersona["runtime"];
type PersonaDraft = SetupPersona;

const STARTER_PERSONAS: PersonaDraft[] = [
  {
    id: "Engineer",
    role: "Software Engineer",
    runtime: "pi",
    workspace: ".",
    model: "",
    system_prompt: "You are the Engineer, a software engineering persona inside Hivemind. Reply naturally and concisely, and collaborate with the other personas in your hive.",
  },
  {
    id: "Reviewer",
    role: "Reviewer",
    runtime: "pi",
    workspace: ".",
    model: "",
    system_prompt: "You are the Reviewer, a careful reviewer inside Hivemind. Reply naturally and concisely, and collaborate with the other personas in your hive.",
  },
];

const RUNTIME_NAMES: Record<Runtime, string> = {
  pi: "Pi",
  omp: "oh-my-pi (OMP)",
  opencode: "OpenCode",
  codex: "Codex",
  claude_code: "Claude Code",
  cursor: "Cursor",
};

function makePersona(index: number): PersonaDraft {
  const id = `Agent${index}`;
  return {
    id,
    role: "General assistant",
    runtime: "pi",
    workspace: ".",
    model: "",
    system_prompt: `You are ${id}, a helpful persona inside Hivemind. Reply naturally and concisely, and collaborate with the other personas in your hive.`,
  };
}

function nextPersonaIndex(personas: PersonaDraft[]) {
  let index = personas.length + 1;
  const ids = new Set(personas.map((persona) => persona.id.trim().toLowerCase()));
  while (ids.has(`agent${index}`)) index += 1;
  return index;
}

export function FirstRunSetup({ onComplete, onSkip }: { onComplete: () => void; onSkip: () => void }) {
  const [step, setStep] = useState<0 | 1>(0);
  const [personas, setPersonas] = useState<PersonaDraft[]>(() => STARTER_PERSONAS.map((persona) => ({ ...persona })));
  const [baseUrl, setBaseUrl] = useState(currentSettings().baseUrl);
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const duplicatePersonaId = personas.some(
    (persona, index) => personas.findIndex((candidate) => candidate.id.trim().toLowerCase() === persona.id.trim().toLowerCase()) !== index,
  );
  const validPersonas = personas.length > 0 && personas.length <= 32 && !duplicatePersonaId && personas.every((persona) => persona.id.trim() && persona.workspace.trim());

  const updatePersona = (index: number, patch: Partial<PersonaDraft>) => {
    setPersonas((current) => current.map((persona, currentIndex) => (currentIndex === index ? { ...persona, ...patch } : persona)));
  };

  const connectServer = async () => {
    const normalizedUrl = baseUrl.trim().replace(/\/+$/, "");
    if (!normalizedUrl) {
      setError("Enter the URL where your Hivemind server is available.");
      return;
    }
    try {
      const parsedUrl = new URL(normalizedUrl);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("Use an http:// or https:// server URL.");
    } catch (reason) {
      setError((reason as Error).message || "Enter a valid server URL.");
      return;
    }

    setConnecting(true);
    setError(null);
    const selectedSettings = { baseUrl: normalizedUrl, token: currentSettings().token };
    applySettings(selectedSettings, false);
    try {
      connect();
      const [info, setup] = await Promise.all([api.info(), api.setupStatus()]);
      applySettings(selectedSettings);
      if (!setup.setup_required) {
        setError(`${info.name} is already configured. Opening the dashboard…`);
        window.setTimeout(onComplete, 700);
        return;
      }
      setStep(1);
    } catch (reason) {
      setError((reason as Error).message || "Could not connect to the Hivemind server.");
    } finally {
      setConnecting(false);
    }
  };

  const saveSetup = async () => {
    setSaving(true);
    setError(null);
    const configuredPersonas = personas.map((persona) => ({
      ...persona,
      model: persona.model?.trim() || undefined,
      reasoning: persona.runtime === "opencode" ? undefined : persona.reasoning?.trim() || undefined,
      fast:
        persona.runtime === "omp" || persona.runtime === "codex"
          ? persona.fast
          : undefined,
    }));
    try {
      const result = await api.completeSetup(configuredPersonas);
      if (!result.saved || result.setup_required) throw new Error("Hivemind did not finish saving the setup.");
      onComplete();
    } catch (reason) {
      setError((reason as Error).message || "Could not save the Hivemind setup.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="setup-page">
      <div className="setup-frame">
        <header className="setup-brand-row">
          <div className="setup-brand">
            <span className="setup-logo" aria-hidden="true">🐝</span>
            <span>Hivemind</span>
          </div>
          <button className="ghost" onClick={onSkip}>Open dashboard</button>
        </header>

        <section className="setup-intro">
          <p className="setup-eyebrow">FIRST-RUN SETUP</p>
          <h1>Get your hive online.</h1>
          <p>Connect to your Hivemind server, add the personas you want, and save the setup directly from this page.</p>
        </section>

        <ol className="setup-steps" aria-label="Setup progress">
          {["Connect", "Configure personas"].map((label, index) => (
            <li key={label} className={step === index ? "current" : step > index ? "complete" : ""}>
              <span className="setup-step-number">{step > index ? "✓" : index + 1}</span>
              <span>{label}</span>
            </li>
          ))}
        </ol>

        <main className="card setup-card">
          {step === 0 && (
            <>
              <div className="setup-card-heading">
                <div>
                  <h2>Connect to Hivemind</h2>
                  <p className="muted">The browser will check whether this server needs its initial setup.</p>
                </div>
              </div>
              <div className="setup-connect-form">
                <label>
                  Server URL
                  <input className="mono" value={baseUrl} onChange={(event) => setBaseUrl(event.currentTarget.value)} placeholder="http://127.0.0.1:7474" />
                </label>
                <p className="muted small">Provider API keys stay inside your selected runtime. Hivemind setup does not store them.</p>
                {error && <div className="error-note" role="alert">{error}</div>}
              </div>
              <div className="row setup-actions">
                <span className="grow" />
                <button className="primary" disabled={connecting} onClick={connectServer}>{connecting ? "Connecting…" : "Connect"}</button>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="setup-card-heading">
                <div>
                  <h2>Configure your personas</h2>
                  <p className="muted">Hivemind will save these settings to its config and apply them immediately.</p>
                </div>
                <span className="badge tone-info">{personas.length} persona{personas.length === 1 ? "" : "s"}</span>
              </div>

              <div className="setup-personas">
                {personas.map((persona, index) => (
                  <section className="setup-persona card" key={index}>
                    <header className="setup-persona-heading">
                      <div className="inline">
                        <span className="setup-persona-icon" aria-hidden="true">{index === 0 ? "✦" : "◈"}</span>
                        <strong>Persona {index + 1}</strong>
                      </div>
                      {personas.length > 1 && (
                        <button className="small ghost" aria-label={`Remove ${persona.id || `persona ${index + 1}`}`} onClick={() => setPersonas((current) => current.filter((_, i) => i !== index))}>Remove</button>
                      )}
                    </header>

                    <div className="setup-fields two-cols">
                      <label>
                        Persona ID
                        <input value={persona.id} maxLength={64} onChange={(event) => updatePersona(index, { id: event.currentTarget.value })} placeholder="Engineer" />
                      </label>
                      <label>
                        Role description
                        <input value={persona.role} maxLength={120} onChange={(event) => updatePersona(index, { role: event.currentTarget.value })} placeholder="Software Engineer" />
                      </label>
                      <label>
                        Runtime
                        <select value={persona.runtime} onChange={(event) => updatePersona(index, { runtime: event.currentTarget.value as Runtime, reasoning: undefined, fast: undefined })}>
                          {Object.entries(RUNTIME_NAMES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                      </label>
                      <label>
                        Workspace <span className="muted small">(path on the server)</span>
                        <input className="mono" value={persona.workspace} maxLength={1024} onChange={(event) => updatePersona(index, { workspace: event.currentTarget.value })} placeholder="." />
                      </label>
                      <label className="setup-full-width">
                        Model <span className="muted small">(optional; runtime default if blank)</span>
                        <input className="mono" value={persona.model ?? ""} maxLength={256} onChange={(event) => updatePersona(index, { model: event.currentTarget.value })} placeholder={persona.runtime === "opencode" ? "opencode/big-pickle" : "provider/model-id"} />
                      </label>
                      {persona.runtime !== "opencode" && (
                        <label>
                          Reasoning <span className="muted small">(optional)</span>
                          <input value={persona.reasoning ?? ""} maxLength={64} onChange={(event) => updatePersona(index, { reasoning: event.currentTarget.value })} placeholder="high" />
                        </label>
                      )}
                      {(persona.runtime === "omp" || persona.runtime === "codex") && (
                        <label className="setup-checkbox">
                          <input type="checkbox" checked={persona.fast ?? false} onChange={(event) => updatePersona(index, { fast: event.currentTarget.checked })} />
                          Start OMP in fast mode
                        </label>
                      )}
                      <label className="setup-full-width">
                        System prompt
                        <textarea rows={3} maxLength={32768} value={persona.system_prompt} onChange={(event) => updatePersona(index, { system_prompt: event.currentTarget.value })} />
                      </label>
                    </div>
                  </section>
                ))}
              </div>

              {duplicatePersonaId && <div className="error-note">Each persona needs a unique ID.</div>}
              {!personas.every((persona) => persona.id.trim()) && <div className="error-note">Persona IDs can’t be blank.</div>}
              {personas.length > 32 && <div className="error-note">Hivemind setup supports up to 32 personas.</div>}
              {error && <div className="error-note" role="alert">{error}</div>}

              <div className="row setup-actions">
                <button onClick={() => setStep(0)}>Back</button>
                <button onClick={() => setPersonas((current) => [...current, makePersona(nextPersonaIndex(current))])} disabled={personas.length >= 32}>＋ Add persona</button>
                <span className="grow" />
                <button className="primary" disabled={!validPersonas || saving} onClick={saveSetup}>{saving ? "Saving…" : "Save setup"}</button>
              </div>
            </>
          )}
        </main>

        <footer className="setup-footer">
          <span>Hivemind stores its config locally on the server. Provider credentials are never included.</span>
        </footer>
      </div>
    </div>
  );
}
