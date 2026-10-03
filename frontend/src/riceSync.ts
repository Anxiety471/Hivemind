// The server keeps the saved rice. This browser keeps unsaved tweaks.
// A local rice is uploaded once, when this browser has never synced and the server has none.
// After that, an empty server means Hive, so one browser's clear is not undone by the others.
import { api } from "./api";
import { subscribeLive, subscribeStatus } from "./live";
import { decideRicePull, getRiceStore, setRiceCommitHook, toServerRice, type CommittedRice } from "./rice";

const SYNCED_KEY = "hivemind.rice.synced";

let pushing = 0;
let pending = false;
let started = false;

function isDefault(state: CommittedRice) {
  return state.selectedId === "hive" && state.custom.length === 0;
}

function hasSynced() {
  try {
    return localStorage.getItem(SYNCED_KEY) === "1";
  } catch {
    return false;
  }
}

function markSynced() {
  try {
    localStorage.setItem(SYNCED_KEY, "1");
  } catch {
    // The next pull will try again. The server document is unchanged.
  }
}

async function push(state: CommittedRice) {
  pushing += 1;
  try {
    if (isDefault(state)) await api.clearUiRice();
    else await api.saveUiRice(toServerRice(state));
    pending = false;
    markSynced();
  } catch {
    pending = true;
  } finally {
    pushing -= 1;
  }
}

export async function pullRice() {
  if (pushing > 0) return;
  const store = getRiceStore();
  if (pending) {
    await push(store.committed());
    return;
  }
  try {
    const { saved } = await api.uiRice();
    if (pushing > 0 || pending) return;
    const decision = decideRicePull({ saved, local: store.committed(), synced: hasSynced() });
    if (decision.kind === "migrate") {
      await push(store.committed());
      return;
    }
    if (decision.kind === "apply") {
      store.applyCommitted(decision.saved);
      markSynced();
    }
  } catch {
    // Offline: the browser copy stays until the server answers.
  }
}

export function startRiceSync() {
  if (started) return;
  started = true;
  setRiceCommitHook((state) => {
    void push(state);
  });
  subscribeLive((event) => {
    if (event.type === "config.changed" && event.payload.scope === "ui") void pullRice();
  });
  subscribeStatus((status) => {
    if (status === "open") void pullRice();
  });
  void pullRice();
}
