#!/usr/bin/env python3
"""Drive Open Cowork headless-RPC end-to-end proof of the ask_teammate mechanism.

Sequence: backgroundTasks.getStats (baseline) → session.start forcing the main
agent to call orchestrate_multi_agent_plan(teamMode=true, crossVerification=false)
→ capture: stdout JSONL events, stored messages, trace steps, swarm_stats.json
(workspace-independent), workspace/teammate-proof.md (raw tool responses written
by the sub-agents themselves — survives even if the main agent's post-tool turn
times out, which happened on attempts 1 and 3), optional session.continue relay
of the "### Teammate questions (opt-in)" section → verdict.

Designed forcing (v4 — deterministic part needs no propagation hop):
  * ARCHITECT gets the GOAL directly in its task prompt (coordinator embeds the
    goal in task-1). Ordered to fire ask_teammate 3x as its VERY FIRST action
    toward roles NOT yet registered → deterministic unavailable/unavailable/limit
    (all cost-0), each response to be appended VERBATIM to teammate-proof.md.
  * developer → reviewer also lands on unavailable (reviewer not yet started).
  * reviewer → security run concurrently → answered path (1 model call) or 30s
    timeout fallback (race — propagation-dependent, honest limitation).
  * main agent told to call the tool with ZERO pre-text to keep the post-tool
    turn's context small (the post-tool generation timed out twice: provider
    context/latency issue, not a mechanism issue).

Verdict exit codes:
  0 = CONFIRME (answered path proven: teammateCalls delta ≥ 1 — only 'answered'
      exchanges set modelCalls=1, swarm-stats.ts:124-129)
  5 = CONFIRME PARTIELLEMENT (palette/tracing/cap/cost-0 fallbacks proven live,
      answered path not reached this run)
  4 = INFIRME (teamMode not recorded / zero bus evidence everywhere)
  2 = setup failure   3 = session error
"""
import glob
import json
import os
import re
import selectors
import subprocess
import sys
import time

BINARY = sys.argv[1] if len(sys.argv) > 1 else "/Applications/Open Cowork.app/Contents/MacOS/Open Cowork"
E2E_DIR = os.path.expanduser("~/Documents/ProjetsGithub/Cowork-e2e-teammate")
WORKDIR = os.path.join(E2E_DIR, "workspace")
PROOF_FILE = os.path.join(WORKDIR, "teammate-proof.md")
CHILD_STDERR = os.path.join(E2E_DIR, "child-stderr.log")

USER_DATA_CANDIDATES = [
    os.path.expanduser("~/Library/Application Support/open-cowork"),
    os.path.expanduser("~/Library/Application Support/Open Cowork"),
]

BLOC = (
    "---BLOC-INSTRUCTIONS-E2E---\n"
    "ARCHITECTE : OBLIGATOIRE — c'est ta TRES PREMIERE action, avant tout travail, "
    "appelle ask_teammate exactement TROIS FOIS dans cet ordre : "
    "(1) target_role=\"developer\", question=\"E2E-A1: nom exact de la fonction d'accueil "
    "attendue dans greeter.ts ?\" ; (2) target_role=\"reviewer\", question=\"E2E-A2: confirme "
    "le nom exact de la fonction d'accueil.\" ; (3) target_role=\"security\", question="
    "\"E2E-A3: une derniere confirmation du nom exact.\" Aucun coequipier n'est encore "
    "inscrit : chaque appel repondra unavailable ou limit — C'EST NORMAL, ne renonce pas, "
    "fais les 3 appels quand meme.\n"
    "PREUVE (tous roles qui posent une question) : apres CHAQUE appel ask_teammate, ajoute "
    "au fichier teammate-proof.md (a la racine du workspace, cree-le s'il n'existe pas) une "
    "ligne au format exact : APPEL <ton role> -> <target_role> : <recopie TEL QUEL la "
    "reponse textuelle rendue par l'outil ask_teammate>.\n"
    "DEVELOPPEUR : ta TRES premiere action est d'appeler ask_teammate une fois vers "
    "target_role=\"reviewer\" avec question=\"E2E-D1: nom exact de la fonction d'accueil "
    "pour greeter.ts ?\" (appelle quand meme, meme si personne n'est inscrit), puis "
    "ecris la ligne de preuve dans teammate-proof.md. PUIS commence TON RAPPORT FINAL par "
    "ce meme bloc recopie mot pour mot.\n"
    "SECURITY : ta DEUXIEME action (APRES avoir fait UNE premiere action de lecture ou "
    "d'analyse — PAS avant, jamais en premiere action) est d'appeler ask_teammate une fois "
    "vers target_role=\"reviewer\" avec question=\"E2E-S1: quel nom exact de fonction "
    "recommandes-tu pour greeter.ts ? Reponds par un seul nom.\", puis ecris la ligne de "
    "preuve dans teammate-proof.md. Ne le devine pas.\n"
    "REVIEWER : n'appelle PAS ask_teammate (tu es la cible de la question).\n"
    "---FIN-BLOC---"
)

GOAL = (
    "Objectif E2E : creer le fichier greeter.ts dans le workspace avec une fonction "
    "d'accueil exportee, puis verifier le canal opt-in ask_teammate entre coequipiers. "
    "Suis imperativement le bloc d'instructions suivant pour chaque role.\n\n" + BLOC
)

PROMPT = (
    "TEST E2E OBLIGATOIRE — execute exactement ceci, sans rien ajouter ni modifier :\n"
    "1. Appelle l'outil orchestrate_multi_agent_plan IMMEDIATEMENT, sans ecrire le moindre "
    "texte ni raisonnement avant l'appel, avec les parametres literaux : "
    "teamMode=true, crossVerification=false, aggregationPolicy=\"fail-all\", "
    "et goal = le texte GOAL ci-dessous, recopie mot pour mot SANS resume :\n"
    "---GOAL---\n" + GOAL + "\n---FIN-GOAL---\n"
    "2. Quand le resultat de l'outil revient, termine ta reponse en recopiant INTEGRALEMENT "
    "toute la section qui commence par '### Teammate questions (opt-in)' (y compris les "
    "lignes 'Q:' et 'A:'). Si cette section n'existe pas dans le resultat, ecris litteralement "
    "'SECTION TEAMMATE ABSENTE'.\n"
    "3. N'execute aucun autre outil avant/apres, ne pose aucune question."
)

RELAY_PROMPT = (
    "Recopie maintenant, INTEGRALEMENT et litteralement, la section '### Teammate questions "
    "(opt-in)' du resultat de l'outil orchestrate_multi_agent_plan de cette session, avec sa "
    "ligne de synthese et TOUTES les lignes '  Q:' et '  A:'. Si elle est absente, ecris "
    "litteralement 'SECTION TEAMMATE ABSENTE'."
)

os.makedirs(WORKDIR, exist_ok=True)  # must exist BEFORE Popen sets it as cwd
for stale in (PROOF_FILE, CHILD_STDERR):
    try:
        os.remove(stale)
    except OSError:
        pass

stderr_fh = open(CHILD_STDERR, "w", encoding="utf-8")  # noqa: SIM115 — drained by the child, never blocks
proc = subprocess.Popen(
    [BINARY, "--headless", "--mode", "rpc", "--auto-approve", "--cwd", WORKDIR],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=stderr_fh,  # file, NOT pipe: an unread pipe wedged attempt 3
    text=True,
    bufsize=1,
    env={**os.environ, "COWORK_MULTI_INSTANCE": "1"},
    cwd=WORKDIR,
)

assistant_text = []
session_status = None
session_id = None
rpc_results = {}
events_raw = []
stdin_broken = False
run_started_at = time.time()


def send(event):
    global stdin_broken
    if stdin_broken or proc.poll() is not None:
        stdin_broken = True
        return
    try:
        line = json.dumps(event)
        proc.stdin.write(line + "\n")
        proc.stdin.flush()
    except (BrokenPipeError, OSError):
        stdin_broken = True


def read_line(timeout):
    if proc.poll() is not None:
        return None
    sel = selectors.DefaultSelector()
    sel.register(proc.stdout, selectors.EVENT_READ)
    deadline = time.time() + timeout
    while time.time() < deadline:
        if sel.select(0.5):
            line = proc.stdout.readline()
            return line if line else None
    return None


def wait_for(predicate, timeout, label):
    global session_status, session_id
    deadline = time.time() + timeout
    while time.time() < deadline:
        if stdin_broken and proc.poll() is not None:
            break
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
        events_raw.append(event)
        etype = event.get("type")
        if etype in ("session.started", "session.status") and event.get("sessionId") and session_id is None:
            session_id = event["sessionId"]
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
        if etype == "trace.step" and event.get("toolName"):
            print(f"[trace.step] tool={event.get('toolName')} status={event.get('status')}")
        if etype == "rpc.result":
            rpc_results[event.get("eventType")] = event.get("result")
            print(f"[rpc.result] {event.get('eventType')}: {json.dumps(event.get('result'), ensure_ascii=False)[:220]}")
        if etype in ("rpc.error", "error"):
            print(f"[{etype}] {json.dumps(event, ensure_ascii=False)[:400]}")
        if predicate(etype, event):
            return event
    raise TimeoutError(label)


def wait_session_idle(timeout=2400, label="session completion"):
    wait_for(
        lambda t, e: (t == "session.status" and e.get("status") in ("idle", "completed", "error")),
        timeout,
        label,
    )


def get_stats():
    send({"type": "backgroundTasks.getStats", "payload": {}})
    wait_for(lambda t, e: t == "rpc.result" and e.get("eventType") == "backgroundTasks.getStats", 60, "stats rpc")
    return rpc_results.get("backgroundTasks.getStats") or {}


def fetch_messages_blob():
    send({"type": "session.getMessages", "payload": {"sessionId": session_id}})
    wait_for(lambda t, e: t == "rpc.result" and e.get("eventType") == "session.getMessages", 60, "getMessages")
    msgs = rpc_results.get("session.getMessages") or []
    return msgs, json.dumps(msgs, ensure_ascii=False)


def read_swarm_stats_file():
    for base in USER_DATA_CANDIDATES:
        p = os.path.join(base, "swarm_stats.json")
        if os.path.exists(p):
            try:
                with open(p, encoding="utf-8") as fh:
                    return p, json.load(fh)
            except Exception as exc:  # noqa: BLE001 — evidence only
                return p, {"__error__": str(exc)}
    return None, {}


def read_proof_file():
    try:
        with open(PROOF_FILE, encoding="utf-8", errors="replace") as fh:
            return fh.read()
    except OSError:
        return ""


def snapshot_logs():
    snap = {}
    for base in USER_DATA_CANDIDATES:
        for p in glob.glob(os.path.join(base, "logs", "app-*.log")):
            try:
                snap[p] = os.path.getmtime(p)
            except OSError:
                pass
    return snap


def collect_oneshot_lines(before_snap):
    out = []
    for base in USER_DATA_CANDIDATES:
        for p in sorted(glob.glob(os.path.join(base, "logs", "app-*.log")), key=os.path.getmtime):
            try:
                with open(p, encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        if "[OneShot]" not in line or not line.startswith("["):
                            continue
                        if p in before_snap and before_snap[p] >= run_started_at - 1:
                            continue
                        stamp = line[1:20]
                        try:
                            ts = time.mktime(time.strptime(stamp, "%Y-%m-%d %H:%M:%S"))
                        except ValueError:
                            ts = 0
                        if ts >= run_started_at - 2:
                            out.append(line.rstrip())
            except OSError:
                continue
    return out


SECTION_RE = re.compile(
    r"-\s*\[\s*(answered|timeout|unavailable|limit)\s*\]\s+(\w+)\s+→\s+(\w+)\s+\((\d+)ms,\s*(\d+)\s+model calls?\)"
)
SUMMARY_RE = re.compile(
    r"(\d+) question\(s\): (\d+) answered, (\d+) timeout, (\d+) unavailable, "
    r"(\d+) refused \(limit\) — (\d+) extra model calls?"
)
APPEL_RE = re.compile(r"APPEL\s+(\w+)\s+->\s+(\w+)\s*:", re.IGNORECASE)


def parse_exchanges(text_blob):
    exchanges = []
    seen = set()
    lines = text_blob.splitlines()
    for i, line in enumerate(lines):
        m = SECTION_RE.search(line.strip())
        if not m:
            continue
        status, src, dst, ms, calls = m.group(1), m.group(2), m.group(3), int(m.group(4)), int(m.group(5))
        q = lines[i + 1].strip()[3:] if i + 1 < len(lines) and lines[i + 1].strip().startswith("Q:") else ""
        a = lines[i + 2].strip()[3:] if i + 2 < len(lines) and lines[i + 2].strip().startswith("A:") else ""
        key = (status, src, dst, q)
        if key in seen:
            continue
        seen.add(key)
        exchanges.append({"status": status, "from": src, "to": dst, "durationMs": ms,
                          "modelCalls": calls, "question": q, "answer": a})
    return exchanges


def parse_summary(text_blob):
    m = SUMMARY_RE.search(text_blob)
    if not m:
        return None
    return {"exchanges": int(m.group(1)), "answered": int(m.group(2)), "timeout": int(m.group(3)),
            "unavailable": int(m.group(4)), "limit": int(m.group(5)), "modelCalls": int(m.group(6))}


def fail(code, reason, artifacts):
    print(f"\nE2E FAIL — {reason}")
    print("Artifacts:", ", ".join(a for a in artifacts if a))
    sys.exit(code)


# ---------------------------------------------------------------------------

logs_before = snapshot_logs()
print(f"[e2e] binary: {BINARY}")
print(f"[e2e] workdir: {WORKDIR}")

print("[e2e] waiting for headless.ready …")
try:
    wait_for(lambda t, e: t == "headless.ready", 300, "headless.ready")
except TimeoutError as exc:
    fail(2, f"startup timeout ({exc})", [])

print("[e2e] baseline swarm stats …")
stats_before_rpc = {}
try:
    stats_before_rpc = get_stats().get("swarm") or {}
except Exception as exc:  # noqa: BLE001
    print(f"[e2e] stats rpc baseline failed: {exc}")
stats_file_before_path, stats_file_before_raw = read_swarm_stats_file()
# File baseline is authoritative (written synchronously at plan completion).
stats_before = stats_file_before_raw or stats_before_rpc
print(f"[e2e] stats before (file): teammateSwarms={stats_before.get('teammateSwarms')} "
      f"teammateCalls={stats_before.get('teammateCalls')} totalSwarms={stats_before.get('totalSwarms')}")

run_started_at = time.time()
logs_before = snapshot_logs()

print("[e2e] starting session (forced orchestrate_multi_agent_plan, teamMode=true) …")
send({
    "type": "session.start",
    "payload": {"title": "Preuve E2E ask_teammate", "prompt": PROMPT, "cwd": WORKDIR},
})

try:
    wait_session_idle(2400, "session completion")
except TimeoutError:
    print("[e2e] WARNING: session completion timeout — continuing with file-based evidence")

elapsed = time.time() - run_started_at
print(f"[e2e] session status={session_status} sid={session_id} in {elapsed:.0f}s")

messages, messages_blob = [], ""
trace_steps = []
if session_id and not stdin_broken:
    try:
        messages, messages_blob = fetch_messages_blob()
        print(f"[e2e] fetched {len(messages)} stored messages")
    except Exception as exc:  # noqa: BLE001
        print(f"[e2e] getMessages failed: {exc}")
    try:
        send({"type": "session.getTraceSteps", "payload": {"sessionId": session_id}})
        wait_for(lambda t, e: t == "rpc.result" and e.get("eventType") == "session.getTraceSteps", 60, "getTraceSteps")
        trace_steps = rpc_results.get("session.getTraceSteps") or []
    except Exception as exc:  # noqa: BLE001
        print(f"[e2e] getTraceSteps failed: {exc}")

tool_names = [s.get("toolName") for s in trace_steps if isinstance(s, dict)]
blob = "\n".join(["\n".join(assistant_text), messages_blob, json.dumps(events_raw, ensure_ascii=False)])
orchestrate_called = "orchestrate_multi_agent_plan" in tool_names or "Multi-Agent Swarm executed" in blob

# Relay fallback (max 2): the post-tool turn timed out on attempts 1 and 3.
if not stdin_broken and session_id:
    for attempt in (1, 2):
        if SUMMARY_RE.search(blob) or read_proof_file():
            break  # section already relayed, or file evidence exists — relay optional
        if not orchestrate_called:
            break
        print(f"[e2e] no section/proof yet — session.continue relay attempt {attempt} …")
        try:
            send({"type": "session.continue", "payload": {"sessionId": session_id, "prompt": RELAY_PROMPT}})
            wait_session_idle(600, f"relay {attempt} completion")
            messages, messages_blob = fetch_messages_blob()
            blob = "\n".join(["\n".join(assistant_text), messages_blob, json.dumps(events_raw, ensure_ascii=False)])
        except Exception as exc:  # noqa: BLE001
            print(f"[e2e] relay attempt {attempt} failed: {exc}")
            break

# Housekeeping: close RPC cleanly; sessions are NOT deleted (DB evidence kept).
try:
    proc.stdin.close()
except Exception:  # noqa: BLE001
    pass
try:
    proc.wait(timeout=30)
except Exception:  # noqa: BLE001
    proc.kill()
try:
    stderr_fh.close()
except Exception:  # noqa: BLE001
    pass

# ------------------------------------------------------------------ evidence

assistant_blob = "\n".join(assistant_text)
proof_text = read_proof_file()
proof_lines = [ln for ln in proof_text.splitlines() if APPEL_RE.search(ln)]
exchanges = parse_exchanges(blob)
summary = parse_summary(blob)
oneshot_lines = collect_oneshot_lines(logs_before)

stats_file_after_path, stats_file_after = read_swarm_stats_file()
stats_after = stats_file_after
stats_after_rpc = {}
try:
    pass  # process already closed; file is authoritative
except Exception:  # noqa: BLE001
    pass

d_swarms = (stats_after.get("teammateSwarms") or 0) - (stats_before.get("teammateSwarms") or 0)
d_calls = (stats_after.get("teammateCalls") or 0) - (stats_before.get("teammateCalls") or 0)

sum_model_calls = sum(e["modelCalls"] for e in exchanges)
by_status = {}
for e in exchanges:
    by_status[e["status"]] = by_status.get(e["status"], 0) + 1
answered = by_status.get("answered", 0) or (summary.get("answered") if summary else 0) or 0

# Bus evidence: section lines, summary line, answered stats delta, OR raw file lines.
bus_evidence = bool(exchanges) or summary is not None or d_calls > 0 or bool(proof_lines)

report = {
    "binary": BINARY,
    "sessionStatus": session_status,
    "elapsedSec": round(elapsed, 1),
    "stdinBroken": stdin_broken,
    "childStderrFile": CHILD_STDERR if os.path.exists(CHILD_STDERR) else None,
    "orchestrateCalled": orchestrate_called,
    "traceToolNames": tool_names,
    "statsBefore": stats_before,
    "statsAfter": stats_after,
    "statsFile": stats_file_after_path,
    "deltaTeammateSwarms": d_swarms,
    "deltaTeammateCalls": d_calls,
    "exchanges": exchanges,
    "exchangesByStatus": by_status,
    "summaryLine": summary,
    "sumParsedModelCalls": sum_model_calls,
    "proofFileLines": proof_lines,
    "proofFileContent": proof_text,
    "oneshotLogLines": oneshot_lines,
    "summaryPresent": summary is not None,
    "sectionAbsentMarker": "SECTION TEAMMATE ABSENTE" in assistant_blob,
    "workspaceFiles": sorted(os.listdir(WORKDIR)),
}

os.makedirs(E2E_DIR, exist_ok=True)
artifacts = []
for name, payload in [
    ("events.jsonl", "\n".join(json.dumps(e, ensure_ascii=False) for e in events_raw)),
    ("report.json", json.dumps(report, indent=2, ensure_ascii=False)),
    ("assistant.txt", assistant_blob),
]:
    p = os.path.join(E2E_DIR, name)
    try:
        with open(p, "w", encoding="utf-8") as fh:
            fh.write(payload)
        artifacts.append(p)
    except OSError:
        pass
artifacts.append(PROOF_FILE if proof_lines else None)
artifacts.append(CHILD_STDERR if os.path.exists(CHILD_STDERR) else None)

print("\n===== ASSISTANT ANSWER (tail) =====")
print(assistant_blob[-2500:])
print("===================================")
print(f"[e2e] orchestrate called      : {orchestrate_called}")
print(f"[e2e] stats delta (file)      : teammateSwarms +{d_swarms}, teammateCalls +{d_calls}")
print(f"[e2e] exchanges parsed        : {len(exchanges)} {by_status} sum(modelCalls)={sum_model_calls}")
print(f"[e2e] summary line parsed     : {summary}")
print(f"[e2e] proof-file APPEL lines  : {len(proof_lines)}")
for ln in proof_lines:
    print("   ", ln[:240])
print(f"[e2e] [OneShot] log lines     : {len(oneshot_lines)}")
for line in oneshot_lines[-6:]:
    print("   ", line[:220])

# ------------------------------------------------------------------- verdict

if session_status == "error":
    fail(3, "session ended in error", artifacts)

if not orchestrate_called and d_swarms < 1:
    fail(4, "orchestrate_multi_agent_plan never recorded a plan — teamMode never activated", artifacts)

if d_swarms < 1:
    fail(4, "swarm_stats teammateSwarms delta = 0 — team mode not recorded (stats file unchanged)", artifacts)

if not bus_evidence:
    fail(4, "ZERO bus evidence: no section line, no summary line, no answered call, "
            "no teammate-proof.md APPEL line — no sub-agent ever invoked ask_teammate "
            "(model non-compliance) and no payload could be relayed. See report.json", artifacts)

# Formula cross-check when per-exchange lines are available.
if exchanges and d_calls != sum_model_calls:
    fail(4, f"cost formula mismatch: stats delta={d_calls} vs parsed sum={sum_model_calls} "
            f"— swarm-stats.ts aggregation broken", artifacts)
if summary and not exchanges and d_calls != summary["modelCalls"]:
    fail(4, f"cost formula mismatch: stats delta={d_calls} vs summary {summary['modelCalls']}", artifacts)

if answered >= 1 or d_calls >= 1:
    n = max(answered, d_calls)
    payload = "section lines" if exchanges else ("summary line" if summary else "stats delta only")
    print(f"\nE2E CONFIRME — {n} answered exchange(s) proven by the stats delta "
          f"(only 'answered' exchanges set modelCalls=1), teammateSwarms +{d_swarms}, "
          f"payload channel: {payload}; cost-0 statuses seen: {by_status or (summary and summary) or 'none in text'}.")
    sys.exit(0)

status_view = by_status or (summary and {k: summary[k] for k in ("exchanges", "answered", "timeout", "unavailable", "limit")})
print(f"\nE2E CONFIRME PARTIELLEMENT — live proof: teammateSwarms +{d_swarms}, "
      f"traced exchanges {status_view or 'n/a'}, raw APPEL payloads captured: {len(proof_lines)}, "
      f"teammateCalls +{d_calls} (0 = only cost-0 outcomes occurred: unavailable/timeout/limit). "
      f"The answered path was NOT reached in this run. See {artifacts}")
sys.exit(5)
