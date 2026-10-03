import { useEffect, useState } from "react";
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
    system_prompt:
      "You are the Engineer, a software engineering persona inside Hivemind. Reply naturally and concisely, and collaborate with the other personas in your hive.",
  },
  {
    id: "Reviewer",
    role: "Reviewer",
    runtime: "pi",
    workspace: ".",
    model: "",
    system_prompt:
      "You are the Reviewer, a careful reviewer inside Hivemind. Reply naturally and concisely, and collaborate with the other personas in your hive.",
  },
];

const RUNTIME_NAMES: Record<Runtime, string> = {
  pi: "Pi",
  omp: "oh-my-pi (OMP)",
  opencode: "OpenCode",
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
  const ids = new Set(
    personas.map((persona) => persona.id.trim().toLowerCase()),
  );
  while (ids.has(`agent${index}`)) index += 1;
  return index;
}

// Keep unfinished work within this tab and server. Tokens are never part of
// this draft. A refresh still starts with a connection check before saving.
function draftKey(baseUrl: string) {
  return `hivemind.setup-draft.v1:${baseUrl.trim().replace(/\/+$/, "")}`;
}
function readDraft(): PersonaDraft[] | null {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(draftKey(currentSettings().baseUrl)) ?? "null",
    );
    if (!Array.isArray(value) || value.length < 1 || value.length > 32)
      return null;
    if (
      !value.every(
        (p) =>
          p &&
          typeof p.id === "string" &&
          typeof p.role === "string" &&
          typeof p.workspace === "string" &&
          typeof p.system_prompt === "string" &&
          ["pi", "omp", "opencode"].includes(p.runtime) &&
          (p.model === undefined || typeof p.model === "string") &&
          (p.reasoning === undefined || typeof p.reasoning === "string") &&
          (p.fast === undefined || typeof p.fast === "boolean"),
      )
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function FirstRunSetup({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [step, setStep] = useState<0 | 1 | 2 | 3 | 4>(0);
  const [personas, setPersonas] = useState<PersonaDraft[]>(
    () => readDraft() ?? STARTER_PERSONAS.map((persona) => ({ ...persona })),
  );
  const [baseUrl, setBaseUrl] = useState(currentSettings().baseUrl);
  const [token, setToken] = useState(currentSettings().token);
  const [connectedUrl, setConnectedUrl] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connectedUrl || step === 4) return;
    try {
      sessionStorage.setItem(draftKey(connectedUrl), JSON.stringify(personas));
    } catch {
      /* Storage is optional. */
    }
  }, [personas, connectedUrl, step]);

  const goTo = (next: 0 | 1 | 2 | 3 | 4) => {
    setError(null);
    setStep(next);
  };

  const duplicatePersonaId = personas.some(
    (persona, index) =>
      personas.findIndex(
        (candidate) =>
          candidate.id.trim().toLowerCase() === persona.id.trim().toLowerCase(),
      ) !== index,
  );
  const validPersonas =
    personas.length > 0 &&
    personas.length <= 32 &&
    !duplicatePersonaId &&
    personas.every((persona) => persona.id.trim() && persona.workspace.trim());

  const updatePersona = (index: number, patch: Partial<PersonaDraft>) => {
    setPersonas((current) =>
      current.map((persona, currentIndex) =>
        currentIndex === index ? { ...persona, ...patch } : persona,
      ),
    );
  };

  const connectServer = async () => {
    const normalizedUrl = baseUrl.trim().replace(/\/+$/, "");
    if (!normalizedUrl) {
      setError("Enter the URL where your Hivemind server is available.");
      return;
    }
    try {
      const parsedUrl = new URL(normalizedUrl);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")
        throw new Error("Use an http:// or https:// server URL.");
    } catch (reason) {
      setError((reason as Error).message || "Enter a valid server URL.");
      return;
    }

    setConnecting(true);
    setError(null);
    const selectedSettings = { baseUrl: normalizedUrl, token: token.trim() };
    const previousSettings = currentSettings();
    applySettings(selectedSettings, false);
    try {
      const [, setup] = await Promise.all([api.info(), api.setupStatus()]);
      applySettings(selectedSettings);
      connect();
      if (!setup.setup_required) {
        onComplete();
        return;
      }
      setConnectedUrl(normalizedUrl);
      setStep(2);
    } catch (reason) {
      applySettings(previousSettings, false);
      setError(
        (reason as Error).message ||
          "Could not connect to the Hivemind server.",
      );
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
      reasoning:
        persona.runtime === "opencode"
          ? undefined
          : persona.reasoning?.trim() || undefined,
      fast: persona.runtime === "omp" ? persona.fast : undefined,
    }));
    try {
      const result = await api.completeSetup(configuredPersonas);
      if (!result.saved || result.setup_required)
        throw new Error("Hivemind did not finish saving the setup.");
      try {
        sessionStorage.removeItem(draftKey(connectedUrl ?? baseUrl));
      } catch {
        /* Storage is optional. */
      }
      setStep(4);
    } catch (reason) {
      setError(
        (reason as Error).message || "Could not save the Hivemind setup.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="setup-page">
      <div className="setup-frame">
        <header className="setup-brand-row">
          <div className="setup-brand">
            <span className="setup-logo" aria-hidden="true">
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
              >
                <path d="M12 2 21 7v10l-9 5-9-5V7Z M12 7l4.5 2.5v5L12 17l-4.5-2.5v-5Z" />
              </svg>
            </span>
            <span>Hivemind</span>
          </div>
          <button
            className="ghost"
            disabled={connecting || saving}
            onClick={step === 4 ? onComplete : onSkip}
          >
            {step === 4 ? "Open dashboard" : "Set up later"}
          </button>
        </header>

        <section className="setup-intro">
          <p className="setup-eyebrow">FIRST-RUN SETUP</p>
          <h1>Get your hive online.</h1>
          <p>
            Build your first team, connect its runtimes, and start
            collaborating. All from your browser.
          </p>
        </section>

        <ol className="setup-steps" aria-label="Setup progress">
          {["Welcome", "Connect", "Your team", "Review", "Ready"].map(
            (label, index) => (
              <li
                key={label}
                aria-current={step === index ? "step" : undefined}
                className={
                  step === index ? "current" : step > index ? "complete" : ""
                }
              >
                <span className="setup-step-number">
                  {step > index ? "✓" : index + 1}
                </span>
                <span>{label}</span>
              </li>
            ),
          )}
        </ol>

        <main className="card setup-card">
          {step === 0 && (
            <>
              <div className="setup-card-heading">
                <div>
                  <h2>Start with a small hive.</h2>
                  <p className="muted">
                    Choose a starting point. You can edit every persona in the
                    next steps.
                  </p>
                </div>
              </div>
              <div className="setup-starters">
                <button
                  className={
                    personas.length === 1
                      ? "setup-starter selected"
                      : "setup-starter"
                  }
                  aria-pressed={personas.length === 1}
                  onClick={() => setPersonas([{ ...STARTER_PERSONAS[0] }])}
                >
                  <span aria-hidden="true">✦</span>
                  <strong>Solo assistant</strong>
                  <span>One engineer for your first conversation.</span>
                </button>
                <button
                  className={
                    personas.length > 1
                      ? "setup-starter selected"
                      : "setup-starter"
                  }
                  aria-pressed={personas.length > 1}
                  onClick={() =>
                    setPersonas(STARTER_PERSONAS.map((p) => ({ ...p })))
                  }
                >
                  <span aria-hidden="true">✦ ◈</span>
                  <strong>Engineer + reviewer</strong>
                  <span>A small team to implement and check work.</span>
                </button>
              </div>
              <p className="muted small">
                Your runtime must already be installed and signed in on the
                server. This guide saves your team; it does not install runtimes
                or verify provider access.
              </p>
              <div className="row setup-actions">
                <span className="grow" />
                <button className="primary" onClick={() => goTo(1)}>
                  Get started
                </button>
              </div>
            </>
          )}

          {step === 1 && (
            <>
              <div className="setup-card-heading">
                <div>
                  <h2>Connect to Hivemind</h2>
                  <p className="muted">
                    The browser will check whether this server needs its initial
                    setup.
                  </p>
                </div>
              </div>
              <div className="setup-connect-form">
                <label>
                  Server URL
                  <input
                    className="mono"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.currentTarget.value)}
                    placeholder="http://127.0.0.1:7474"
                  />
                </label>
                <label>
                  Server access token{" "}
                  <span className="muted small">
                    (only if your server requires one)
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={token}
                    onChange={(event) => setToken(event.currentTarget.value)}
                  />
                </label>
                <p className="muted small">
                  Provider API keys stay inside your selected runtime. Hivemind
                  setup does not store them.
                </p>
                {error && (
                  <div className="error-note" role="alert">
                    {error}
                  </div>
                )}
              </div>
              <div className="row setup-actions">
                <button disabled={connecting} onClick={() => goTo(0)}>
                  Back
                </button>
                <span className="grow" />
                <button
                  className="primary"
                  disabled={connecting}
                  onClick={connectServer}
                >
                  {connecting ? "Connecting…" : "Connect"}
                </button>
              </div>
            </>
          )}

          {step === 2 && (
            <>
              <div className="setup-card-heading">
                <div>
                  <h2>Configure your personas</h2>
                  <p className="muted">
                    Hivemind will save these settings to its config and apply
                    them immediately.
                  </p>
                </div>
                <span className="badge tone-info">
                  {personas.length} persona{personas.length === 1 ? "" : "s"}
                </span>
              </div>

              <p className="setup-connected small">
                ✓ Connected to <span className="mono">{connectedUrl}</span>
              </p>
              <div className="setup-personas">
                {personas.map((persona, index) => (
                  <section className="setup-persona card" key={index}>
                    <header className="setup-persona-heading">
                      <div className="inline">
                        <span className="setup-persona-icon" aria-hidden="true">
                          {index === 0 ? "✦" : "◈"}
                        </span>
                        <strong>Persona {index + 1}</strong>
                      </div>
                      {personas.length > 1 && (
                        <button
                          className="small ghost"
                          aria-label={`Remove ${persona.id || `persona ${index + 1}`}`}
                          onClick={() =>
                            setPersonas((current) =>
                              current.filter((_, i) => i !== index),
                            )
                          }
                        >
                          Remove
                        </button>
                      )}
                    </header>

                    <div className="setup-fields two-cols">
                      <label>
                        Persona ID
                        <input
                          value={persona.id}
                          maxLength={64}
                          onChange={(event) =>
                            updatePersona(index, {
                              id: event.currentTarget.value,
                            })
                          }
                          placeholder="Engineer"
                        />
                      </label>
                      <label>
                        Role description
                        <input
                          value={persona.role}
                          maxLength={120}
                          onChange={(event) =>
                            updatePersona(index, {
                              role: event.currentTarget.value,
                            })
                          }
                          placeholder="Software Engineer"
                        />
                      </label>
                      <label>
                        Runtime
                        <select
                          value={persona.runtime}
                          onChange={(event) =>
                            updatePersona(index, {
                              runtime: event.currentTarget.value as Runtime,
                              reasoning: undefined,
                              fast: undefined,
                            })
                          }
                        >
                          {Object.entries(RUNTIME_NAMES).map(
                            ([value, label]) => (
                              <option key={value} value={value}>
                                {label}
                              </option>
                            ),
                          )}
                        </select>
                      </label>
                      <label>
                        Workspace{" "}
                        <span className="muted small">
                          (path on the server)
                        </span>
                        <input
                          className="mono"
                          value={persona.workspace}
                          maxLength={1024}
                          onChange={(event) =>
                            updatePersona(index, {
                              workspace: event.currentTarget.value,
                            })
                          }
                          placeholder="."
                        />
                      </label>
                      <p className="setup-full-width muted small">
                        {persona.runtime === "omp"
                          ? "OMP uses the credentials and models from your oh-my-pi installation."
                          : persona.runtime === "opencode"
                            ? "OpenCode uses its own provider configuration. Models use provider/model-id format."
                            : "Pi uses the provider credentials from your Pi installation."}
                      </p>
                      <details className="setup-full-width setup-advanced">
                        <summary>Model and behavior (optional)</summary>
                        <div className="setup-fields two-cols">
                          <label className="setup-full-width">
                            Model{" "}
                            <span className="muted small">
                              (optional; runtime default if blank)
                            </span>
                            <input
                              className="mono"
                              value={persona.model ?? ""}
                              maxLength={256}
                              onChange={(event) =>
                                updatePersona(index, {
                                  model: event.currentTarget.value,
                                })
                              }
                              placeholder={
                                persona.runtime === "opencode"
                                  ? "opencode/big-pickle"
                                  : "provider/model-id"
                              }
                            />
                          </label>
                          {persona.runtime !== "opencode" && (
                            <label>
                              Reasoning{" "}
                              <span className="muted small">(optional)</span>
                              <input
                                value={persona.reasoning ?? ""}
                                maxLength={64}
                                onChange={(event) =>
                                  updatePersona(index, {
                                    reasoning: event.currentTarget.value,
                                  })
                                }
                                placeholder="high"
                              />
                            </label>
                          )}
                          {persona.runtime === "omp" && (
                            <label className="setup-checkbox">
                              <input
                                type="checkbox"
                                checked={persona.fast ?? false}
                                onChange={(event) =>
                                  updatePersona(index, {
                                    fast: event.currentTarget.checked,
                                  })
                                }
                              />
                              Start OMP in fast mode
                            </label>
                          )}
                          <label className="setup-full-width">
                            System prompt
                            <textarea
                              rows={3}
                              maxLength={32768}
                              value={persona.system_prompt}
                              onChange={(event) =>
                                updatePersona(index, {
                                  system_prompt: event.currentTarget.value,
                                })
                              }
                            />
                          </label>
                        </div>
                      </details>
                    </div>
                  </section>
                ))}
              </div>

              {duplicatePersonaId && (
                <div className="error-note">
                  Each persona needs a unique ID.
                </div>
              )}
              {!personas.every((persona) => persona.workspace.trim()) && (
                <div className="error-note" role="alert">
                  Each persona needs a workspace path on the server.
                </div>
              )}
              {!personas.every((persona) => persona.id.trim()) && (
                <div className="error-note">Persona IDs can’t be blank.</div>
              )}
              {personas.length > 32 && (
                <div className="error-note">
                  Hivemind setup supports up to 32 personas.
                </div>
              )}
              {error && (
                <div className="error-note" role="alert">
                  {error}
                </div>
              )}

              <div className="row setup-actions">
                <button onClick={() => goTo(1)}>Back</button>
                <button
                  onClick={() =>
                    setPersonas((current) => [
                      ...current,
                      makePersona(nextPersonaIndex(current)),
                    ])
                  }
                  disabled={personas.length >= 32}
                >
                  ＋ Add persona
                </button>
                <span className="grow" />
                <button
                  className="primary"
                  disabled={!validPersonas}
                  onClick={() => goTo(3)}
                >
                  Review setup
                </button>
              </div>
            </>
          )}
          {step === 3 && (
            <>
              <div className="setup-card-heading">
                <div>
                  <h2>Review your hive</h2>
                  <p className="muted">
                    Check your team before saving it to the server.
                  </p>
                </div>
              </div>
              <p className="setup-connected small">
                ✓ Connected to <span className="mono">{connectedUrl}</span>
              </p>
              <div className="setup-review-list">
                {personas.map((persona, index) => (
                  <section className="card setup-review-persona" key={index}>
                    <h3>{persona.id.trim()}</h3>
                    <p>{persona.role || "General assistant"}</p>
                    <dl>
                      <dt>Runtime</dt>
                      <dd>{RUNTIME_NAMES[persona.runtime]}</dd>
                      <dt>Workspace</dt>
                      <dd className="mono">{persona.workspace.trim()}</dd>
                      <dt>Model</dt>
                      <dd>{persona.model?.trim() || "Runtime default"}</dd>
                      {persona.runtime !== "opencode" && (
                        <>
                          <dt>Reasoning</dt>
                          <dd>
                            {persona.reasoning?.trim() || "Runtime default"}
                          </dd>
                        </>
                      )}
                      {persona.runtime === "omp" && (
                        <>
                          <dt>Fast mode</dt>
                          <dd>{persona.fast ? "On" : "Off"}</dd>
                        </>
                      )}
                    </dl>
                    <details>
                      <summary>System prompt</summary>
                      <p className="setup-prompt">
                        {persona.system_prompt || "No additional prompt"}
                      </p>
                    </details>
                  </section>
                ))}
              </div>
              <p className="muted small">
                Saving creates the configuration and makes your personas
                available immediately. Runtime sign-in is still required before
                they can reply.
              </p>
              {error && (
                <div className="error-note" role="alert">
                  {error}
                </div>
              )}
              <div className="row setup-actions">
                <button disabled={saving} onClick={() => goTo(2)}>
                  Edit team
                </button>
                <span className="grow" />
                <button
                  className="primary"
                  disabled={saving || !validPersonas}
                  onClick={saveSetup}
                >
                  {saving ? "Saving…" : "Save setup"}
                </button>
              </div>
            </>
          )}
          {step === 4 && (
            <div className="setup-ready" role="status">
              <span className="setup-ready-icon" aria-hidden="true">
                ✓
              </span>
              <h2>Your hive is ready.</h2>
              <p>
                {personas.length} persona{personas.length === 1 ? "" : "s"}{" "}
                saved to your server.
              </p>
              <p className="muted">
                Open Rooms and send “hello” to meet your team. Manage personas
                in Agents and track delegated work in Tasks.
              </p>
              <button className="primary" onClick={onComplete}>
                Start chatting
              </button>
            </div>
          )}
        </main>

        <footer className="setup-footer">
          <span>
            Hivemind stores its config locally on the server. Provider
            credentials are never included.
          </span>
        </footer>
      </div>
    </div>
  );
}
