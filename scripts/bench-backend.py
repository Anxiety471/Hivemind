#!/usr/bin/env python3
"""Backend overhead benchmark: Hivemind against an instant fake Pi runtime.

    cargo build --release --bin hivemind
    python3 scripts/bench-backend.py --scenario all --out bench.json
    python3 scripts/bench-backend.py --scenario solo --turns 1000 --root ~/.cache/hmbench

Numbers measure Hivemind overhead only: the fake runtime replies instantly.
`--root` picks the filesystem under test (tmpfs hides fsync cost; use a real
disk for durability numbers). Each scenario gets its own scratch directory and
server process, removed afterwards unless --keep. Server CPU comes from
/proc/<pid>/stat utime+stime, so this is Linux-only. Never part of `cargo test`.
"""
import argparse, base64, http.client, json, os, random, shutil, socket, statistics, struct
import subprocess, sys, tempfile, threading, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLK_TCK = os.sysconf("SC_CLK_TCK")
PAGE = os.sysconf("SC_PAGE_SIZE")

# Speaks the subset of Pi RPC that src/runtime/pi.rs uses. With FAKEPI_TOOLS=k
# every user prompt first gets k memory.search tool calls, then a text answer.
FAKE_PI = r'''#!/usr/bin/env python3
import json, os, sys
tools = int(os.environ.get("FAKEPI_TOOLS", "0"))
pending = 0
def emit(frame):
    sys.stdout.write(json.dumps(frame) + "\n")
def answer(text):
    emit({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": text}],
          "usage": {"input": 100, "output": 20}}})
    emit({"type": "agent_settled"})
    sys.stdout.flush()
for line in sys.stdin:
    frame = json.loads(line)
    kind = frame.get("type")
    if kind == "get_session_stats":
        emit({"type": "response", "command": "get_session_stats", "success": True,
              "data": {"contextUsage": {"tokens": 1000, "contextWindow": 200000, "percent": 0.5}}})
        sys.stdout.flush()
    elif kind == "prompt":
        with open(os.environ["FAKEPI_PROMPTS"], "a") as log:
            log.write("1")
        message = frame.get("message", "")
        if not message.startswith("Memory tool result:"):
            pending = tools
        if pending > 0:
            pending -= 1
            words = [w for w in message.split() if w.isalpha()][-6:] or ["status"]
            call = {"name": "memory.search", "args": {"query": " ".join(words), "limit": 8}}
            answer("Looking things up.\n```hivemind-tool\n" + json.dumps(call) + "\n```\n")
        else:
            answer("ack " + " ".join(message.split()[-12:]))
'''

WORDS = ("alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa "
         "quebec romeo sierra tango uniform victor whiskey xray yankee zulu deploy build cache index query "
         "schema table vector socket thread worker latency budget memory session runtime planner review "
         "release branch commit merge rebase config tokens context summary archive group persona room").split()


def pct(values, q):
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, int(q * len(ordered)))], 2)


def proc_cpu(pid):
    fields = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()
    return (int(fields[11]) + int(fields[12])) / CLK_TCK


def proc_rss_mb(pid):
    return round(int(open(f"/proc/{pid}/statm").read().split()[1]) * PAGE / 1e6, 1)


class WsClient(threading.Thread):
    """Minimal RFC 6455 reader that drains frames and answers pings."""

    def __init__(self, port):
        super().__init__(daemon=True)
        self.frames = 0
        self.sock = socket.create_connection(("127.0.0.1", port))
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f"GET /api/v1/ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.sock.recv(1)
        assert b" 101 " in buf.split(b"\r\n")[0], buf
        self.start()

    def _read(self, n):
        data = b""
        while len(data) < n:
            chunk = self.sock.recv(n - len(data))
            if not chunk:
                raise EOFError
            data += chunk
        return data

    def run(self):
        try:
            while True:
                b1, b2 = self._read(2)
                length = b2 & 0x7F
                if length == 126:
                    length = struct.unpack(">H", self._read(2))[0]
                elif length == 127:
                    length = struct.unpack(">Q", self._read(8))[0]
                payload = self._read(length)
                opcode = b1 & 0x0F
                if opcode == 1:
                    self.frames += 1
                elif opcode == 9:
                    mask = os.urandom(4)
                    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
                    self.sock.sendall(bytes([0x8A, 0x80 | len(payload)]) + mask + masked)
                elif opcode == 8:
                    return
        except (EOFError, OSError):
            return

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class Hive:
    def __init__(self, args, name, personas, groups=(), tools=0):
        self.args = args
        os.makedirs(args.root, exist_ok=True)
        self.dir = tempfile.mkdtemp(prefix=f"hmbench-{name}-", dir=args.root)
        workspace = os.path.join(self.dir, "workspace")
        os.makedirs(workspace)
        fake = os.path.join(self.dir, "fakepi.py")
        open(fake, "w").write(FAKE_PI)
        os.chmod(fake, 0o755)
        blocks = "".join(f'[[personas]]\nid = "{p}"\nruntime = "pi"\nworkspace = "{workspace}"\n'
                         f'system_prompt = "You are {p}."\n\n' for p in personas)
        groups = "".join(f'[[groups]]\nid = "{g}"\nmembers = {json.dumps(m)}\n\n' for g, m in groups)
        self.config = os.path.join(self.dir, "hivemind.toml")
        open(self.config, "w").write(f'[runtime]\npi_binary = "{fake}"\nidle_timeout_secs = 0\n\n{groups}{blocks}')
        self.prompt_log = os.path.join(self.dir, "prompts.log")
        self.env = dict(os.environ, FAKEPI_TOOLS=str(tools), FAKEPI_PROMPTS=self.prompt_log)
        for kind in ("DATA", "CONFIG", "STATE", "CACHE"):
            path = os.path.join(self.dir, "xdg", kind.lower())
            os.makedirs(path)
            self.env[f"XDG_{kind}_HOME"] = path
        self.proc = None
        self.local = threading.local()

    def start(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        began = time.perf_counter()
        self.proc = subprocess.Popen([self.args.server, "--config", self.config, "serve", "--port", str(self.port)],
                                     cwd=self.dir, env=self.env,
                                     stdout=subprocess.DEVNULL,
                                     stderr=open(os.path.join(self.dir, "server.log"), "w"))
        while True:
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/v1/health", timeout=1)
                break
            except OSError:
                if self.proc.poll() is not None or time.perf_counter() - began > 30:
                    raise RuntimeError("server did not start: " + open(os.path.join(self.dir, "server.log")).read()[-800:])
                time.sleep(0.002)
        self.startup_ms = round((time.perf_counter() - began) * 1000, 1)
        return self

    def turn(self, target, message):
        """One keep-alive connection per calling thread; returns wall ms."""
        conn = getattr(self.local, "conn", None)
        if conn is None:
            conn = self.local.conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=120)
        body = json.dumps({"target": target, "message": message})
        began = time.perf_counter()
        conn.request("POST", "/api/v1/turns", body, {"Content-Type": "application/json"})
        response = conn.getresponse()
        data = response.read()
        elapsed = (time.perf_counter() - began) * 1000
        if response.status != 200:
            raise RuntimeError(f"turn failed {response.status}: {data[:300]!r}")
        return elapsed

    def cpu(self):
        return proc_cpu(self.proc.pid)

    def rss(self):
        return proc_rss_mb(self.proc.pid)

    def prompts(self):
        """Runtime prompts the fake Pi has received so far."""
        return os.path.getsize(self.prompt_log) if os.path.exists(self.prompt_log) else 0

    def db_mb(self):
        path = os.path.join(self.dir, ".hivemind")
        total = sum(os.path.getsize(os.path.join(path, f)) for f in os.listdir(path)) if os.path.isdir(path) else 0
        return round(total / 1e6, 2)

    def stop(self):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(15)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
            self.proc = None
        if not self.args.keep:
            shutil.rmtree(self.dir, ignore_errors=True)


def message(rng):
    return " ".join(rng.choice(WORDS) for _ in range(rng.randint(8, 24)))


def window(hive, target, rng, count):
    """Run `count` sequential turns; latency stats plus server CPU per turn."""
    cpu, prompts = hive.cpu(), hive.prompts()
    began = time.perf_counter()
    lat = [hive.turn(target, message(rng)) for _ in range(count)]
    wall = time.perf_counter() - began
    return {"turns": count, "p50_ms": pct(lat, 0.5), "p90_ms": pct(lat, 0.9), "max_ms": round(max(lat), 2),
            "cpu_ms_per_turn": round((hive.cpu() - cpu) * 1000 / count, 2),
            "wall_ms_per_turn": round(wall * 1000 / count, 2),
            "runtime_prompts_per_turn": round((hive.prompts() - prompts) / count, 2)}


def history_windows(hive, target, rng, turns, marks):
    """Fill history to each mark, measuring a window at each one."""
    out, done = [], 0
    for mark in marks:
        if mark > turns:
            break
        measure = min(50, mark - done)
        for _ in range(mark - done - measure):
            hive.turn(target, message(rng))
        stats = window(hive, target, rng, measure)
        done = mark
        out.append({"history": mark, **stats, "rss_mb": hive.rss(), "db_mb": hive.db_mb()})
        print(f"  {target} history={mark} {stats}", file=sys.stderr, flush=True)
    return out


def scenario_solo(args, rng):
    hive = Hive(args, "solo", ["solo0"]).start()
    try:
        idle = hive.rss()
        first = hive.turn({"type": "solo", "id": "solo0"}, message(rng))
        marks = [m for m in (50, 100, 300, 500, 1000, 2000, 5000) if m <= args.turns] or [args.turns]
        return {"startup_ms": hive.startup_ms, "idle_rss_mb": idle, "first_turn_ms": round(first, 2),
                "windows": history_windows(hive, {"type": "solo", "id": "solo0"}, rng, args.turns, marks)}
    finally:
        hive.stop()


def scenario_group(args, rng):
    out = []
    for size in (1, 3, 8):
        members = [f"m{i}" for i in range(size)]
        hive = Hive(args, f"group{size}", members, groups=[("g", members)]).start()
        try:
            target = {"type": "group", "id": "g"}
            hive.turn(target, message(rng))
            marks = sorted({min(args.group_turns, m) for m in (50, args.group_turns)})
            out.append({"members": size, "windows": history_windows(hive, target, rng, args.group_turns, marks)})
        finally:
            hive.stop()
    return out


def scenario_concurrency(args, rng):
    rooms = [f"c{i}" for i in range(args.rooms)]
    hive = Hive(args, "concurrency", rooms).start()
    try:
        per_room = args.concurrent_turns

        def run_room(room):
            local = random.Random(room)
            return [hive.turn({"type": "solo", "id": room}, message(local)) for _ in range(per_room)]

        for room in rooms:  # warm every runtime so spawn cost is excluded
            hive.turn({"type": "solo", "id": room}, message(rng))
        result = {}
        for mode in ("serial", "concurrent"):
            cpu, began = hive.cpu(), time.perf_counter()
            if mode == "serial":
                lat = [x for room in rooms for x in run_room(room)]
            else:
                with ThreadPoolExecutor(len(rooms)) as pool:
                    lat = [x for chunk in pool.map(run_room, rooms) for x in chunk]
            wall = time.perf_counter() - began
            result[mode] = {"rooms": len(rooms), "turns": len(lat), "turns_per_s": round(len(lat) / wall, 1),
                            "p50_ms": pct(lat, 0.5), "p90_ms": pct(lat, 0.9),
                            "cpu_ms_per_turn": round((hive.cpu() - cpu) * 1000 / len(lat), 2)}
            print(f"  {mode} {result[mode]}", file=sys.stderr, flush=True)
        return result
    finally:
        hive.stop()


def scenario_tools(args, rng):
    out = []
    for tools in (0, 1, 4):
        hive = Hive(args, f"tools{tools}", ["t0"], tools=tools).start()
        try:
            target = {"type": "solo", "id": "t0"}
            hive.turn(target, message(rng))
            marks = sorted({min(args.tool_turns, m) for m in (50, args.tool_turns)})
            out.append({"tool_calls_per_turn": tools,
                        "windows": history_windows(hive, target, rng, args.tool_turns, marks)})
        finally:
            hive.stop()
    return out


def scenario_ws(args, rng):
    """Each client count gets a fresh room at the same room history. The archive
    FTS match is global, so a trailing 0-client control step shows drift."""
    steps = (0, 1, 10, 50, 0)
    out = []
    hive = Hive(args, "ws", [f"w{i}" for i in range(len(steps))]).start()
    try:
        for i in range(len(steps)):
            for _ in range(20):
                hive.turn({"type": "solo", "id": f"w{i}"}, message(rng))
        clients = []
        for i, count in enumerate(steps):
            while len(clients) < count:
                clients.append(WsClient(hive.port))
            while len(clients) > count:
                clients.pop().close()
            time.sleep(0.2)
            before = sum(c.frames for c in clients)
            stats = window(hive, {"type": "solo", "id": f"w{i}"}, rng, args.ws_turns)
            time.sleep(0.2)
            frames = sum(c.frames for c in clients) - before
            out.append({"ws_clients": count, **stats, "frames_per_turn": round(frames / args.ws_turns, 2)})
            print(f"  ws={count} {stats}", file=sys.stderr, flush=True)
        for client in clients:
            client.close()
        return out
    finally:
        hive.stop()


SCENARIOS = {"solo": scenario_solo, "group": scenario_group, "concurrency": scenario_concurrency,
             "tools": scenario_tools, "ws": scenario_ws}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scenario", choices=[*SCENARIOS, "all"], default="all")
    parser.add_argument("--server", default=os.path.join(ROOT, "target", "release", "hivemind"))
    parser.add_argument("--root", default=tempfile.gettempdir(), help="parent dir for scratch data (picks the filesystem)")
    parser.add_argument("--turns", type=int, default=1000, help="solo history length")
    parser.add_argument("--group-turns", type=int, default=200)
    parser.add_argument("--tool-turns", type=int, default=200)
    parser.add_argument("--rooms", type=int, default=8)
    parser.add_argument("--concurrent-turns", type=int, default=25, help="turns per room")
    parser.add_argument("--ws-turns", type=int, default=50)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--keep", action="store_true", help="keep scratch dirs")
    parser.add_argument("--out", help="write JSON results here (default stdout)")
    args = parser.parse_args()
    args.root = os.path.expanduser(args.root)
    args.server = os.path.abspath(os.path.expanduser(args.server))
    if not os.access(args.server, os.X_OK):
        sys.exit(f"server binary not found: {args.server} (cargo build --release --bin hivemind)")

    fs = subprocess.run(["stat", "-f", "-c", "%T", args.root], capture_output=True, text=True).stdout.strip()
    commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    report = {"commit": commit, "server": args.server, "root": args.root, "filesystem": fs,
              "nproc": os.cpu_count(), "at": time.strftime("%Y-%m-%dT%H:%M:%S"), "results": {}}
    for name in SCENARIOS if args.scenario == "all" else [args.scenario]:
        print(f"== {name} ({fs} at {args.root})", file=sys.stderr, flush=True)
        report["results"][name] = SCENARIOS[name](args, random.Random(args.seed))
    text = json.dumps(report, indent=2)
    if args.out:
        open(args.out, "w").write(text + "\n")
    else:
        print(text)


if __name__ == "__main__":
    main()
