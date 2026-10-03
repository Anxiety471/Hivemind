import { createRoot } from "react-dom/client";
import { lazy, Suspense, useEffect, useState } from "react";
import { api, hasSavedSettings } from "./api";
import { connect, useLiveStatus } from "./live";
import { Chat } from "./views/Chat";
import { FirstRunSetup } from "./views/FirstRunSetup";
import { Icon, Logo, type IconName } from "./icons";
import { CommandLayer } from "./CommandPalette";
import { requestNewIssue } from "./nav";
import { applyTheme, storedTheme } from "./theme";
import { Kbd } from "./ui";
const Library = lazy(() => import("./views/Library").then((m) => ({ default: m.Library })));
const Issues = lazy(() => import("./views/Issues").then((m) => ({ default: m.Issues })));
const Agents = lazy(() => import("./views/Agents").then((m) => ({ default: m.Agents })));
const Groups = lazy(() => import("./views/Groups").then((m) => ({ default: m.Groups })));
const WorkspacesView = lazy(() => import("./views/Workspaces").then((m) => ({ default: m.WorkspacesView })));
const Sessions = lazy(() => import("./views/Sessions").then((m) => ({ default: m.Sessions })));
const Activity = lazy(() => import("./views/Activity").then((m) => ({ default: m.Activity })));
const SettingsView = lazy(() => import("./views/Settings").then((m) => ({ default: m.SettingsView })));
import "./content.css";
import "./styles.css";

type Route = { page: string; arg?: string };

function parse(): Route {
  const [page = "rooms", ...rest] = location.hash.replace(/^#\/?/, "").split("/");
  return { page: page || "rooms", arg: rest.length ? decodeURIComponent(rest.join("/")) : undefined };
}

type NavItem = { page: string; label: string; icon: IconName; also?: string[] };

const NAV: { section?: string; items: NavItem[] }[] = [
  {
    items: [
      { page: "issues", label: "Issues", icon: "issues", also: ["tasks"] },
      { page: "rooms", label: "Rooms", icon: "rooms" },
      { page: "library", label: "Library", icon: "library" },
    ],
  },
  {
    section: "Hive",
    items: [
      { page: "agents", label: "Agents", icon: "agents" },
      { page: "groups", label: "Groups", icon: "groups" },
      { page: "workspaces", label: "Workspaces", icon: "workspaces" },
    ],
  },
  {
    section: "System",
    items: [
      { page: "sessions", label: "Runtime sessions", icon: "sessions" },
      { page: "activity", label: "Live activity", icon: "activity" },
      { page: "setup", label: "Setup guide", icon: "setup" },
    ],
  },
];

const FIRST_RUN_KEY = "hivemind.first_run_complete";

function shouldShowFirstRun() {
  try {
    return localStorage.getItem(FIRST_RUN_KEY) !== "true" && !hasSavedSettings();
  } catch {
    return true;
  }
}

function App() {
  const [route, setRoute] = useState(parse);
  const live = useLiveStatus();
  const [version, setVersion] = useState<string | null>(null);
  const [firstRun, setFirstRun] = useState(shouldShowFirstRun);
  const [palette, setPalette] = useState(false);

  const leaveSetup = () => {
    try {
      localStorage.setItem(FIRST_RUN_KEY, "true");
    } catch {
      // Setup still works when browser storage is unavailable.
    }
    setFirstRun(false);
    if (location.hash !== "#/rooms") location.hash = "#/rooms";
    else setRoute({ page: "rooms" });
  };

  useEffect(() => {
    const onHash = () => setRoute(parse());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  useEffect(() => {
    api
      .info()
      .then((i) => setVersion(i.version))
      .catch(() => setVersion(null));
  }, [live]);

  if (firstRun) return <FirstRunSetup onComplete={leaveSetup} onSkip={leaveSetup} />;

  let view;
  switch (route.page) {
    case "library":
      view = <Library selected={route.arg} />;
      break;
    case "issues":
    case "tasks":
      view = <Issues selected={route.arg} />;
      break;
    case "agents":
      view = <Agents key={route.arg ?? ""} create={route.arg === "new"} />;
      break;
    case "groups":
      view = <Groups key={route.arg ?? ""} create={route.arg === "new"} />;
      break;
    case "workspaces":
      view = <WorkspacesView />;
      break;
    case "sessions":
      view = <Sessions roomId={route.arg} />;
      break;
    case "activity":
      view = <Activity />;
      break;
    case "settings":
      view = <SettingsView />;
      break;
    case "setup":
      view = <FirstRunSetup onComplete={leaveSetup} onSkip={leaveSetup} />;
      break;
    default:
      view = <Chat roomId={route.arg} />;
  }

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <span className="logo">
            <Logo />
          </span>
          <span className="brand-name">Hivemind</span>
          <button className="brand-new" onClick={requestNewIssue} title="New issue (C)" aria-label="New issue">
            <Icon name="edit" size={14} />
          </button>
        </div>
        <button className="nav search-nav" onClick={() => setPalette(true)} aria-label="Search and commands">
          <span className="nav-icon">
            <Icon name="search" />
          </span>
          <span className="nav-label">Search</span>
          <span className="nav-kbd">
            <Kbd>⌘K</Kbd>
          </span>
        </button>
        {NAV.map((group, i) => (
          <div className="nav-group" key={group.section ?? i}>
            {group.section && <div className="nav-section">{group.section}</div>}
            {group.items.map((item) => {
              const active = route.page === item.page || item.also?.includes(route.page);
              return (
                <a key={item.page} href={`#/${item.page}`} className={active ? "nav active" : "nav"}>
                  <span className="nav-icon">
                    <Icon name={item.icon} />
                  </span>
                  <span className="nav-label">{item.label}</span>
                </a>
              );
            })}
          </div>
        ))}
        <div className="spacer" />
        <a href="#/settings" className={route.page === "settings" ? "nav active" : "nav"}>
          <span className="nav-icon">
            <Icon name="settings" />
          </span>
          <span className="nav-label">Settings</span>
        </a>
        <div className="conn" data-status={live}>
          <span className="dot" />
          {live === "open" ? "Live" : live === "connecting" ? "Connecting…" : "Offline"}
          {version && <span className="ver">v{version}</span>}
        </div>
      </nav>
      <main className="main">
        <Suspense fallback={null}>{view}</Suspense>
      </main>
      <CommandLayer paletteOpen={palette} setPaletteOpen={setPalette} />
    </div>
  );
}

applyTheme(storedTheme(), false);
connect();
createRoot(document.getElementById("app")!).render(<App />);
