// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DriveRoutes } from "./DriveRoutes";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

vi.mock("../auth/Auth", () => ({
  AuthPage: ({ mode }: { mode: string }) => <div>auth:{mode}</div>,
  PasswordResetPage: () => <div>reset</div>,
}));
vi.mock("../space/files/FilesPage", () => ({ FilesPage: () => <div>files page</div> }));
vi.mock("../../components/billing/SubscriptionGate", () => ({
  SubscriptionGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

function Where() {
  const { pathname, search } = useLocation();
  return <div data-where>{pathname + search}</div>;
}

const mounted: Array<{ unmount: () => void; host: HTMLElement }> = [];

async function renderAt(path: string, signedIn: boolean, next: string | null = null) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({ unmount: () => root.unmount(), host });
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <DriveRoutes signedIn={signedIn} next={next} />
        <Where />
      </MemoryRouter>,
    );
  });
  // The pages are lazy: let their imports settle.
  await act(async () => {
    await flush();
  });
  return {
    text: host.textContent ?? "",
    where: host.querySelector("[data-where]")?.textContent ?? "",
  };
}

afterEach(() => {
  for (const { unmount, host } of mounted.splice(0)) {
    act(unmount);
    host.remove();
  }
});

describe("DriveRoutes", () => {
  it("opens Files for a signed-in visitor, from the root or any unknown path", async () => {
    const root = await renderAt("/", true);
    expect(root.text).toContain("files page");
    expect(root.where).toBe("/app/files");
    const unknown = await renderAt("/app/board", true);
    expect(unknown.text).toContain("files page");
    expect(unknown.where).toBe("/app/files");
  });

  it("sends a signed-out visitor to sign in and returns them to the page they asked for", async () => {
    const page = await renderAt("/app/files/folder/f1", false);
    expect(page.text).toContain("auth:in");
    expect(page.where).toBe(`/sign-in?next=${encodeURIComponent("/app/files/folder/f1")}`);
  });

  it("sends a visitor who just signed in to the page asked for", async () => {
    const page = await renderAt("/sign-in", true, "/app/files/folder/f1");
    expect(page.text).toContain("files page");
    expect(page.where).toBe("/app/files/folder/f1");
  });
});
