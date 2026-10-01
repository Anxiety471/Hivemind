#!/bin/sh
# Start `hivemind serve` against a throwaway demo hive that uses the scripted
# fake-pi.py runtime, so the UI can be developed without a model or credentials.
#   frontend/dev/demo.sh            # serves http://127.0.0.1:7474
#   HIVEMIND_BIN=hivemind PORT=7575 frontend/dev/demo.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
demo=${DEMO_DIR:-"$here/.demo"}
bin=${HIVEMIND_BIN:-"$root/target/debug/hivemind"}
port=${PORT:-7474}

mkdir -p "$demo/repo" "$demo/docs"
if [ ! -d "$demo/repo/.git" ]; then
  git -C "$demo/repo" init -q -b main
  echo "demo" > "$demo/repo/README.md"
  git -C "$demo/repo" add -A
  git -C "$demo/repo" -c user.name=demo -c user.email=demo@example.com commit -q -m init
fi
if [ ! -f "$demo/hivemind.toml" ]; then
  cat > "$demo/hivemind.toml" <<TOML
[runtime]
pi_binary = "$here/fake-pi.py"
prompt_timeout_secs = 60
idle_timeout_secs = 120

[conversation]
reply_order = ["Engineer", "Reviewer"]

[memory]
mode = "deterministic"

[coordination]
enabled = true
planner = "Lead"

[workspaces]
roots = ["$demo"]

[[personas]]
id = "Lead"
role = "Tech Lead"
runtime = "pi"
system_prompt = "You are the Lead, who plans and reviews work."
workspace = "$demo/repo"
permissions = ["coordinate", "review"]

[[personas]]
id = "Engineer"
role = "Software Engineer"
runtime = "pi"
system_prompt = "You are the Engineer, a software engineering agent."
workspace = "$demo/repo"
capabilities = ["backend", "frontend"]

[[personas]]
id = "Reviewer"
role = "Reviewer"
runtime = "pi"
system_prompt = "You are the Reviewer, a careful reviewer and systems thinker."
workspace = "$demo/repo"
permissions = ["review"]

[[groups]]
id = "development"
mode = "discussion"
members = ["Engineer", "Reviewer"]
reply_order = ["Reviewer", "Engineer"]
workspace = "$demo/repo"
[groups.member_roles]
Engineer = "Backend Engineer"
Reviewer = "Architecture Reviewer"
TOML
fi
cd "$demo"
exec "$bin" serve --config "$demo/hivemind.toml" --port "$port"
