#!/usr/bin/env python3
"""Scripted stand-in for the Pi RPC runtime used by the browser e2e tests.

Prompts containing SLOW take three seconds; MARKDOWN answers with a CRLF Markdown
document (the shape some runtimes emit); everything else echoes the persona.
"""
import json, re, sys, time

args = sys.argv[1:]
system = args[args.index("--append-system-prompt") + 1] if "--append-system-prompt" in args else ""
match = re.search(r"You are the (\w+)", system)
persona = match.group(1) if match else "Agent"


def send(frame):
    sys.stdout.write(json.dumps(frame) + "\n")
    sys.stdout.flush()


MARKDOWN = "# Plan  \r\n\r\n\r\n\r\n- first **bold** step\r\n- second `code` step\r\n\r\n```python\r\nprint('hi')  \r\n```\r\n\r\n    if ready:\r\n        run()\r\n\r\nfirst line  \r\nsecond line\r\n"

for line in sys.stdin:
    try:
        frame = json.loads(line)
    except ValueError:
        continue
    kind = frame.get("type")
    if kind == "prompt":
        message = frame.get("message", "")
        send({"type": "response", "command": "prompt", "success": True})
        if "SLOW" in message:
            time.sleep(3)
        text = MARKDOWN if "MARKDOWN" in message else f"{persona} here."
        send({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": text}],
              "usage": {"input": 1, "output": 1, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 2}}})
        send({"type": "agent_settled"})
    elif kind == "get_session_stats":
        send({"type": "response", "command": "get_session_stats", "success": True, "data": {"contextUsage": {"tokens": 1}}})
    else:
        send({"type": "response", "command": kind, "success": True})
