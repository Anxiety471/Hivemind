#!/usr/bin/env python3
"""Opt-in end-to-end run of Hivemind against real OpenCode free models.

    HIVEMIND_E2E_OPENCODE=1 python3 scripts/e2e-opencode.py

Never part of `cargo test`. Every scenario gets its own scratch directory, an
isolated XDG data/config/state/cache root (so OpenCode session state never
touches your real data) and an empty workspace. Free-tier models may forward
prompts to third-party providers: do not put secrets in the workspace.
Models are queried at run time from `opencode models` (names ending in
`opencode/*-free`, the provider that needs no API key); the run is skipped when fewer than one is available. There are no
retries: a rate-limited or flaky model fails the scenario.
Scenario 6 also needs working `pi` and `omp` binaries and is skipped without them.
"""
import json, os, shutil, signal, socket, sqlite3, subprocess, sys, tempfile, threading, time
import base64, struct, urllib.request, uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVER = os.path.join(ROOT, "target", "debug", "hivemind")
OPENCODE = os.environ.get("OPENCODE_BIN", "opencode")
results = []


def record(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name} {detail}".rstrip(), flush=True)


def free_models():
    out = subprocess.run([OPENCODE, "models"], capture_output=True, text=True, timeout=60).stdout
    listed = [m.strip() for m in out.splitlines() if m.strip().startswith("opencode/") and m.strip().endswith("-free")]
    return [m for m in listed if model_answers(m)]


def model_answers(model):
    """One probe per model: free endpoints come and go, and this only selects test data."""
    scratch = tempfile.mkdtemp(prefix="hivemind-e2e-probe-")
    env = dict(os.environ, **{f"XDG_{k}_HOME": os.path.join(scratch, k.lower()) for k in ("DATA", "CONFIG", "STATE", "CACHE")})
    try:
        run = subprocess.run([OPENCODE, "run", "--standalone", "-m", model, "--format", "json", "reply with just: ok"],
                             cwd=scratch, env=env, capture_output=True, text=True, timeout=90)
        return '"type":"text"' in run.stdout.replace(" ", "")
    except subprocess.TimeoutExpired:
        return False
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def descendants(pid):
    parents = {}
    for entry in os.listdir("/proc"):
        if entry.isdigit():
            try:
                stat = open(f"/proc/{entry}/stat").read()
                parents[int(entry)] = int(stat.rsplit(")", 1)[1].split()[1])
            except (OSError, IndexError):
                pass
    found, frontier = set(), {pid}
    while frontier:
        frontier = {p for p, pp in parents.items() if pp in frontier} - found
        found |= frontier
    return found


class WsClient(threading.Thread):
    """Minimal RFC 6455 reader: collects JSON text frames, answers pings."""

    def __init__(self, port):
        super().__init__(daemon=True)
        self.events = []
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
                    self.events.append(json.loads(payload))
                elif opcode == 9:
                    mask = os.urandom(4)
                    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
                    self.sock.sendall(bytes([0x8A, 0x80 | len(payload)]) + mask + masked)
                elif opcode == 8:
                    return
        except (EOFError, OSError):
            return

    def types(self):
        return [e.get("type") for e in self.events]


class Hive:
    def __init__(self, name, personas, groups="", conversation="", runtime="", context=""):
        self.dir = tempfile.mkdtemp(prefix=f"hivemind-e2e-{name}-")
        self.workspace = os.path.join(self.dir, "workspace")
        os.makedirs(self.workspace)
        self.xdg = {f"XDG_{k}_HOME": os.path.join(self.dir, "xdg", k.lower()) for k in ("DATA", "CONFIG", "STATE", "CACHE")}
        for path in self.xdg.values():
            os.makedirs(path)
        blocks = "".join(
            f'[[personas]]\nid = "{p["id"]}"\nruntime = "{p.get("runtime", "opencode")}"\n'
            f'workspace = "{self.workspace}"\nsystem_prompt = "{p.get("prompt", "You are " + p["id"] + ". Reply in one short sentence.")}"\n'
            + (f'model = "{p["model"]}"\n' if p.get("model") else "") + "\n"
            for p in personas)
        self.config = os.path.join(self.dir, "hivemind.toml")
        open(self.config, "w").write(
            f'[runtime]\nopencode_binary = "{OPENCODE}"\n{runtime}\n{conversation}\n{context}\n{groups}\n{blocks}')
        self.proc = None

    def start(self):
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        env = dict(os.environ, **self.xdg)
        self.proc = subprocess.Popen([SERVER, "--config", self.config, "serve", "--port", str(self.port)],
                                     cwd=self.dir, env=env, stderr=open(os.path.join(self.dir, "server.log"), "w"))
        for _ in range(100):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/api/v1/health", timeout=1)
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("server did not start: " + open(os.path.join(self.dir, "server.log")).read()[-500:])
        self.ws = WsClient(self.port)

    def turn(self, target, message, timeout=240):
        body = json.dumps({"target": target, "message": message}).encode()
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}/api/v1/turns", body,
                                     {"Content-Type": "application/json"})
        return json.load(urllib.request.urlopen(req, timeout=timeout))

    def stop(self):
        """SIGINT and report descendants that survive core shutdown."""
        if not self.proc:
            return []
        family = descendants(self.proc.pid)
        self.proc.send_signal(signal.SIGINT)
        try:
            self.proc.wait(30)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        time.sleep(1)
        self.proc = None
        return sorted(p for p in family if os.path.exists(f"/proc/{p}") and not is_zombie(p))

    def sql(self, query, *args):
        db = sqlite3.connect(os.path.join(self.dir, ".hivemind", "memory.sqlite3"))
        try:
            return db.execute(query, args).fetchall()
        finally:
            db.close()

    def cleanup(self):
        self.stop()
        shutil.rmtree(self.dir, ignore_errors=True)


def is_zombie(pid):
    try:
        return open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[0] == "Z"
    except OSError:
        return True


def scenario(fn):
    try:
        fn()
    except Exception as error:  # a scenario failure must not hide the others
        record(fn.__name__, False, f"raised {error!r}")


def main():
    if os.environ.get("HIVEMIND_E2E_OPENCODE") != "1":
        sys.exit("set HIVEMIND_E2E_OPENCODE=1 to run this opt-in E2E (it calls real free models)")
    if shutil.which(OPENCODE) is None:
        sys.exit(f"skipped: '{OPENCODE}' not found on PATH")
    models = free_models()
    if not models:
        sys.exit("skipped: `opencode models` lists no answering 'opencode/*-free' model")
    print("usable free models:", models)
    subprocess.run(["cargo", "build", "--bin", "hivemind"], cwd=ROOT, check=True)
    first, second = models[0], models[1 % len(models)]
    solo = {"type": "solo", "id": "Alpha"}
    alpha = {"id": "Alpha", "model": first}
    beta = {"id": "Beta", "model": second}

    def s1_context_retained():
        hive = Hive("ctx", [alpha])
        try:
            hive.start()
            hive.turn(solo, "Remember this codeword: ZEBRA-4711. Reply with just: ok")
            pids = {p for p in descendants(hive.proc.pid)}
            reply = hive.turn(solo, "What codeword did I tell you? Answer with the codeword only.")
            same = pids <= descendants(hive.proc.pid)
            ok = "ZEBRA-4711" in reply["replies"][0]["content"] and same
            record("1 single agent keeps context on one live child", ok, f"same_children={same} reply={reply['replies'][0]['content']!r}")
            leftover = hive.stop()
            record("7 shutdown leaves no opencode descendants", not leftover, f"leftover={leftover}")
        finally:
            hive.cleanup()

    def s2_two_agents_order():
        group = '[[groups]]\nname = "duo"\nmode = "discussion"\nmembers = ["Beta", "Alpha"]\n'
        hive = Hive("order", [alpha, beta], groups=group,
                    conversation='[conversation]\nreply_order = ["Beta", "Alpha"]')
        try:
            hive.start()
            out = hive.turn({"type": "group", "id": "duo"},
                            "Beta says the codeword KIWI-3141 exactly. Alpha then repeats the codeword Beta said.")
            names = [r["persona_id"] for r in out["replies"]]
            alpha_text = out["replies"][-1]["content"]
            record("2 two agents reply in configured order and see each other",
                   names == ["Beta", "Alpha"] and all(r["ok"] for r in out["replies"]) and "KIWI-3141" in alpha_text,
                   f"order={names} alpha={alpha_text!r}")
        finally:
            hive.cleanup()

    def s3_memory_roundtrip():
        marker = "e2e-marker-" + uuid.uuid4().hex[:8]
        hive = Hive("mem", [alpha])
        try:
            hive.start()
            hive.turn(solo, f"Use the memory.private.add tool to save exactly this content: {marker}")
            rows = hive.sql("select layer, content, status from memories where content like ?", f"%{marker}%")
            record("3 memory tool write is in the SQLite store", bool(rows), f"rows={rows}")
        finally:
            hive.cleanup()

    def s4_rotation():
        hive = Hive("rot", [alpha], context="[context]\ncontext_target_tokens = 1500\nsummary_max_tokens = 500\nruntime_rotate_tokens = 1501")
        try:
            hive.start()
            hive.turn(solo, "Say hi.")
            hive.turn(solo, "Say hi again.")
            time.sleep(1)
            record("4 runtime.rotated observed on WebSocket", "runtime.rotated" in hive.ws.types(), f"types={sorted(set(hive.ws.types()))}")
        finally:
            hive.cleanup()

    def s5_prompt_timeout():
        hive = Hive("timeout", [alpha], runtime="prompt_timeout_secs = 1")
        try:
            hive.start()
            out = hive.turn(solo, "Write a 500 word essay about bees.")
            time.sleep(1)
            failed = not out["replies"][0]["ok"]
            epochs = hive.sql("select ended_at is not null from runtime_epochs")
            hive.stop()
            text = open(hive.config).read().replace("prompt_timeout_secs = 1", "prompt_timeout_secs = 300")
            open(hive.config, "w").write(text)
            hive.start()
            after = hive.turn(solo, "Say hi.")
            fresh = hive.sql("select count(*) from runtime_epochs")[0][0]
            record("5 prompt timeout fails the reply, closes the epoch, next turn starts fresh",
                   failed and epochs and all(e[0] for e in epochs) and after["replies"][0]["ok"] and fresh >= 2,
                   f"failed={failed} epochs={epochs} after_ok={after['replies'][0]['ok']} total_epochs={fresh}")
        finally:
            hive.cleanup()

    def s6_mixed_room():
        if not (shutil.which("pi") and shutil.which("omp")):
            print("[SKIP] 6 mixed room: pi and/or omp not on PATH")
            return
        hive = Hive("mixed", [{"id": "Alpha", "runtime": "pi"}, {"id": "Beta", "runtime": "omp"}, {"id": "Gamma", "model": first}],
                    conversation='[conversation]\nreply_order = ["Gamma", "Beta", "Alpha"]')
        try:
            hive.start()
            out = hive.turn({"type": "main"}, "Each of you: reply with one short sentence.")
            names = [r["persona_id"] for r in out["replies"]]
            record("6 mixed pi/omp/opencode room replies in order",
                   names == ["Gamma", "Beta", "Alpha"] and all(r["ok"] for r in out["replies"]), f"order={names}")
        finally:
            hive.cleanup()

    gamma = {"id": "Gamma", "model": models[2 % len(models)]}

    def texts(out):
        return [r["content"] for r in out["replies"]]

    def s8_conversation_tree():
        """One hive, five rooms branching from the same three personas."""
        tag = uuid.uuid4().hex[:6].upper()
        secret_a, secret_b = f"ALPHA-{tag}", f"BETA-{tag}"
        groups = ('[[groups]]\nid = "duo"\nmode = "broadcast"\nmembers = ["Alpha", "Beta"]\n\n'
                  '[[groups]]\nid = "trio"\nmode = "discussion"\nmembers = ["Alpha", "Beta", "Gamma"]\n')
        hive = Hive("tree", [alpha, beta, gamma], groups=groups,
                    conversation='[conversation]\nreply_order = ["Alpha", "Beta", "Gamma"]')
        checks = {}
        try:
            hive.start()
            hive.turn({"type": "solo", "id": "Alpha"}, f"Remember this codeword: {secret_a}. Reply with just: ok")
            hive.turn({"type": "solo", "id": "Beta"}, f"Remember this codeword: {secret_b}. Reply with just: ok")
            # Branch 1: a group room must not inherit either solo room's history.
            duo = hive.turn({"type": "group", "id": "duo"},
                            "Each of you: state any secret codeword you were told earlier, or say UNKNOWN.")
            checks["duo isolated from solo rooms"] = not any(s in t for t in texts(duo) for s in (secret_a, secret_b))
            # Branch 2: discussion chain, each member builds on the previous reply.
            chain = hive.turn({"type": "group", "id": "trio"},
                              "Goal: compute in a chain. Alpha says the number 17. Beta adds 5 to Alpha's number and says the result. "
                              "Gamma doubles Beta's result and says it. Everyone answers with the number only.")
            checks["discussion chain reaches 44"] = "44" in texts(chain)[-1] and [r["persona_id"] for r in chain["replies"]] == ["Alpha", "Beta", "Gamma"]
            follow = hive.turn({"type": "group", "id": "trio"}, "Everyone: what was the final number of the chain? Number only.")
            checks["follow-up turn in same room recalls 44"] = all("44" in t for t in texts(follow))
            goal = hive.sql("select state_json from group_state where group_id like ?", "%trio%")
            checks["Goal directive persisted for trio"] = any("compute in a chain" in row[0] for row in goal)
            # Branch 3: back to a solo room; its own history continued, the sibling's did not leak.
            back_a = hive.turn({"type": "solo", "id": "Alpha"}, "What codeword did I tell you? Also, what is Beta's codeword? Say UNKNOWN if you do not know it.")
            checks["solo Alpha keeps own secret, not Beta's"] = secret_a in texts(back_a)[0] and secret_b not in texts(back_a)[0]
            # Branch 4: main room is yet another tree branch with all three.
            main = hive.turn({"type": "main"}, "Everyone: say hello in five words or fewer.")
            checks["main room all three reply"] = [r["persona_id"] for r in main["replies"]] == ["Alpha", "Beta", "Gamma"] and all(r["ok"] for r in main["replies"])
            rows = hive.sql("select count(*), count(distinct instance_id) from runtime_epochs")[0]
            detail = hive.sql("select instance_id, ended_at is not null, metadata_json from runtime_epochs order by started_at")
            # solo Alpha, solo Beta, duo x2, trio x3, main x3 = 10 distinct room+persona instances
            # a flaky free model may force one extra restart, so only the distinct-instance count is exact
            checks["exactly one runtime instance per room+persona"] = rows[1] == 10 and rows[0] >= 10
            leftover = hive.stop()
            checks["no children survive shutdown"] = not leftover
            bad = [k for k, v in checks.items() if not v]
            record("8 conversation tree across solo/group/discussion/main rooms", not bad, f"failed={bad} epochs={rows} detail={detail if bad else ''}")
        finally:
            hive.cleanup()

    def s9_long_conversation_across_rotations():
        secret = "PLUM-" + uuid.uuid4().hex[:5].upper()
        hive = Hive("long", [alpha], context="[context]\ncontext_target_tokens = 1500\nsummary_max_tokens = 500\nruntime_rotate_tokens = 1501")
        try:
            hive.start()
            hive.turn(solo, f"Remember this codeword: {secret}. Reply with just: ok")
            for topic in ("bees", "rivers", "chess", "tea"):
                hive.turn(solo, f"Say one short sentence about {topic}.")
            final = hive.turn(solo, "What codeword did I ask you to remember at the very start? Codeword only.")
            time.sleep(1)
            rotations = hive.ws.types().count("runtime.rotated")
            epochs = hive.sql("select count(*) from runtime_epochs")[0][0]
            record("9 six-turn conversation survives repeated rotations",
                   secret in texts(final)[0] and rotations >= 2 and epochs >= 3,
                   f"rotations={rotations} epochs={epochs} reply={texts(final)[0]!r}")
        finally:
            hive.cleanup()

    every = (s1_context_retained, s2_two_agents_order, s3_memory_roundtrip, s4_rotation, s5_prompt_timeout, s6_mixed_room, s8_conversation_tree, s9_long_conversation_across_rotations)
    only = os.environ.get("HIVEMIND_E2E_ONLY")  # e.g. "s8,s9": run just those scenarios
    for fn in every:
        if not only or fn.__name__.split("_")[0] in only.split(","):
            scenario(fn)
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} scenarios passed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
