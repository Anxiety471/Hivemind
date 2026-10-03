import { Chats } from "@phosphor-icons/react/dist/csr/Chats";
import { Books } from "@phosphor-icons/react/dist/csr/Books";
import { Stack } from "@phosphor-icons/react/dist/csr/Stack";
import { Robot } from "@phosphor-icons/react/dist/csr/Robot";
import { Users } from "@phosphor-icons/react/dist/csr/Users";
import { Folder } from "@phosphor-icons/react/dist/csr/Folder";
import { ArrowsClockwise } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { Broadcast } from "@phosphor-icons/react/dist/csr/Broadcast";
import { MagicWand } from "@phosphor-icons/react/dist/csr/MagicWand";
import { GearSix } from "@phosphor-icons/react/dist/csr/GearSix";
import { Hexagon } from "@phosphor-icons/react/dist/csr/Hexagon";
import { createRoot } from "react-dom/client";
import { lazy, Suspense, useEffect, useState } from "react";
import { api, hasSavedSettings } from "./api";
import { connect, useLiveStatus } from "./live";
import { Chat } from "./views/Chat";
import { FirstRunSetup } from "./views/FirstRunSetup";
const Library = lazy(() => import("./views/Library").then((m) => ({ default: m.Library })));
const Tasks = lazy(() => import("./views/Tasks").then((m) => ({ default: m.Tasks })));
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

const NAV = [
  { page: "rooms", label: "Rooms", icon: "💬" },
  { page: "library", label: "Library", icon: "📚" },
  { page: "tasks", label: "Tasks", icon: "🗂️" },
  { page: "agents", label: "Agents", icon: "🤖" },
  { page: "groups", label: "Groups", icon: "👥" },
  { page: "workspaces", label: "Workspaces", icon: "📁" },
  { page: "sessions", label: "Runtime sessions", icon: "♻️" },
  { page: "activity", label: "Live activity", icon: "📡" },
  { page: "setup", label: "Setup guide", icon: "✨" },
];

const TICKET_NAV_ICONS = [Chats, Books, Stack, Robot, Users, Folder, ArrowsClockwise, Broadcast, MagicWand];

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
    case "tasks":
      view = <Tasks selected={route.arg} />;
      break;
    case "agents":
      view = <Agents />;
      break;
    case "groups":
      view = <Groups />;
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
    <div className={route.page === "tasks" ? "shell ticket-shell" : "shell"}>
      <nav className="sidebar">
        <div className="brand">
          <span className="logo">{route.page === "tasks" ? <Hexagon size={20} weight="duotone" /> : "🐝"}</span>
          <span>Hivemind</span>
        </div>
        {NAV.map((item, index) => { const Icon = TICKET_NAV_ICONS[index]; return (
          <div key={item.page}><a href={`#/${item.page}`} className={route.page === item.page ? "nav active" : "nav"}>
            <span className="nav-icon">{route.page === "tasks" ? <Icon size={15} /> : item.icon}</span>
            {item.label}
          </a>
          {item.page === "tasks" && route.page === "tasks" && <div className="ticket-subnav" aria-label="Task views">{[{ id: "active", label: "Active" }, { id: "backlog", label: "Backlog" }, { id: "all", label: "All issues" }, { id: "closed", label: "Closed" }].map((v) => <a key={v.id} href={`#/tasks/${v.id}`} aria-current={(route.arg ?? "active") === v.id ? "page" : undefined}>{v.label}</a>)}</div>}
          </div>
        ); })}
        <div className="spacer" />
        <a href="#/settings" className={route.page === "settings" ? "nav active" : "nav"}>
          <span className="nav-icon">{route.page === "tasks" ? <GearSix size={15} /> : "⚙️"}</span>
          Connection
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
    </div>
  );
}

connect();
createRoot(document.getElementById("app")!).render(<App />);
