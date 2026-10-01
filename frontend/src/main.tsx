import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api } from "./api";
import { connect, useLiveStatus } from "./live";
import { Chat } from "./views/Chat";
import { Tasks } from "./views/Tasks";
import { Agents } from "./views/Agents";
import { Groups } from "./views/Groups";
import { WorkspacesView } from "./views/Workspaces";
import { Sessions } from "./views/Sessions";
import { Activity } from "./views/Activity";
import { SettingsView } from "./views/Settings";
import "./styles.css";

type Route = { page: string; arg?: string };

function parse(): Route {
  const [page = "rooms", ...rest] = location.hash.replace(/^#\/?/, "").split("/");
  return { page: page || "rooms", arg: rest.length ? decodeURIComponent(rest.join("/")) : undefined };
}

const NAV = [
  { page: "rooms", label: "Rooms", icon: "💬" },
  { page: "tasks", label: "Tasks", icon: "🗂️" },
  { page: "agents", label: "Agents", icon: "🤖" },
  { page: "groups", label: "Groups", icon: "👥" },
  { page: "workspaces", label: "Workspaces", icon: "📁" },
  { page: "sessions", label: "Runtime sessions", icon: "♻️" },
  { page: "activity", label: "Live activity", icon: "📡" },
];

function App() {
  const [route, setRoute] = useState(parse);
  const live = useLiveStatus();
  const [version, setVersion] = useState<string | null>(null);

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

  let view;
  switch (route.page) {
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
    default:
      view = <Chat roomId={route.arg} />;
  }

  return (
    <div class="shell">
      <nav class="sidebar">
        <div class="brand">
          <span class="logo">🐝</span>
          <span>Hivemind</span>
        </div>
        {NAV.map((item) => (
          <a key={item.page} href={`#/${item.page}`} class={route.page === item.page ? "nav active" : "nav"}>
            <span class="nav-icon">{item.icon}</span>
            {item.label}
          </a>
        ))}
        <div class="spacer" />
        <a href="#/settings" class={route.page === "settings" ? "nav active" : "nav"}>
          <span class="nav-icon">⚙️</span>
          Connection
        </a>
        <div class="conn" data-status={live}>
          <span class="dot" />
          {live === "open" ? "Live" : live === "connecting" ? "Connecting…" : "Offline"}
          {version && <span class="ver">v{version}</span>}
        </div>
      </nav>
      <main class="main">{view}</main>
    </div>
  );
}

connect();
render(<App />, document.getElementById("app")!);
