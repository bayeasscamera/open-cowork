#!/usr/bin/env python3
"""Drive Open Cowork headless-RPC end-to-end proof of the Projects feature.

Sequence: projects.create → projects.attachFile → session.start(projectId)
→ collect the assistant's real LLM answer → assert it reflects BOTH the project
instructions AND the reference-file content (facts the model cannot know
otherwise).
"""
import json
import os
import subprocess
import sys
import time

BINARY = sys.argv[1]
E2E_DIR = os.path.expanduser("~/Documents/ProjetsGithub/Cowork-e2e-projet")
WORKDIR = os.path.join(E2E_DIR, "workspace")
REF_FILE = os.path.join(E2E_DIR, "cahier-des-charges.md")

INSTRUCTIONS = (
    "Règle absolue de ce projet : commence CHAQUE réponse par le marqueur exact "
    "[PROJET-AO], puis réponds en français en une seule phrase."
)
PROMPT = (
    "Quel est le code d'accès interne de ce projet et quel est son budget maximum "
    "en euros ? Applique strictement les règles de réponse de ce projet."
)

REQUIRED_FACTS = ["TRIBORD-42", "12 500", "[PROJET-AO]"]

proc = subprocess.Popen(
    [BINARY, "--headless", "--mode", "rpc"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    text=True,
    bufsize=1,
    env={**os.environ, "COWORK_MULTI_INSTANCE": "1"},
    cwd=WORKDIR,
)

assistant_text = []
session_status = None
rpc_results = {}
stderr_tail = []


def send(event):
    line = json.dumps(event)
    proc.stdin.write(line + "\n")
    proc.stdin.flush()


def read_line(timeout):
    # Line-buffered read with a wall-clock budget; None on timeout/EOF.
    import selectors

    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if sel.select(0.5):
            line = proc.stdout.readline()
            return line if line else None
    return None


def wait_for(predicate, timeout, label):
    global session_status
    deadline = time.time() + timeout
    while time.time() < deadline:
        line = read_line(5)
        if line is None:
            continue
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        etype = event.get("type")
        if etype == "stream.message" and event.get("role") == "assistant":
            content = event.get("content")
            if isinstance(content, str):
                assistant_text.append(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        assistant_text.append(block.get("text", ""))
        if etype == "session.status":
            session_status = event.get("status")
            print(f"[status] {session_status}")
        if etype == "rpc.result":
            rpc_results[event.get("eventType")] = event.get("result")
            print(f"[rpc.result] {event.get('eventType')}: {json.dumps(event.get('result'), ensure_ascii=False)[:220]}")
        if etype == "error":
            print(f"[error] {json.dumps(event, ensure_ascii=False)[:400]}")
        if predicate(etype, event):
            return event
    raise TimeoutError(label)


print("[e2e] waiting for headless.ready …")
wait_for(lambda t, e: t == "headless.ready", 300, "headless.ready")

print("[e2e] creating project …")
send({
    "type": "projects.create",
    "payload": {"name": "Projet AO — Preuve E2E", "workdir": WORKDIR, "instructions": INSTRUCTIONS},
})
wait_for(lambda t, e: t == "rpc.result" and e.get("eventType") == "projects.create", 120, "projects.create")
create_result = rpc_results.get("projects.create") or {}
if not create_result.get("success"):
    print("[e2e] FAIL: projects.create unsuccessful:", create_result)
    sys.exit(2)
project = create_result.get("project") or {}
project_id = project.get("id")
print(f"[e2e] project id: {project_id}")

print("[e2e] attaching reference file …")
send({"type": "projects.attachFile", "payload": {"projectId": project_id, "path": REF_FILE}})
wait_for(lambda t, e: t == "rpc.result" and e.get("eventType") == "projects.attachFile", 120, "projects.attachFile")
attach_result = rpc_results.get("projects.attachFile") or {}
ref_files = (attach_result.get("project") or {}).get("referenceFiles") or []
print(f"[e2e] reference files on project: {ref_files}")

print("[e2e] starting session inside the project …")
send({
    "type": "session.start",
    "payload": {"title": "Preuve contexte projet", "prompt": PROMPT, "projectId": project_id},
})

# Session end: session.status idle/completed/error (session.ended also exists).
wait_for(
    lambda t, e: (t == "session.status" and e.get("status") in ("idle", "completed", "error")),
    600,
    "session completion",
)

try:
    proc.stdin.close()
except Exception:
    pass
try:
    proc.wait(timeout=30)
except Exception:
    proc.kill()

answer = "\n".join(assistant_text).strip()
print("\n===== ASSISTANT ANSWER =====")
print(answer)
print("===========================\n")

missing = [fact for fact in REQUIRED_FACTS if fact not in answer]
if session_status == "error":
    print("E2E FAIL — session ended in error")
    sys.exit(3)
if missing:
    print(f"E2E FAIL — the answer misses facts injectable only via project context: {missing}")
    sys.exit(4)
print("E2E PASS — instructions + reference-file content demonstrably reached the model.")
