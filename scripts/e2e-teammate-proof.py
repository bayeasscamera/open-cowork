#!/usr/bin/env python3
"""Drive Open Cowork headless-RPC end-to-end proof of the ask_teammate mechanism.

Sequence: backgroundTasks.getStats (baseline) → session.start forcing the main
agent to call orchestrate_multi_agent_plan(teamMode=true, crossVerification=false)
→ collect the assistant's real stream + full message list + trace steps →
backgroundTasks.getStats (after) → swarm_stats.json delta → app-log scan for the
responder's [OneShot] call (provider/model actually used) → parse the
"### Teammate questions (opt-in)" section (payload Q + answer A + status +
modelCalls per exchange) → verdict.

Designed forcing (see GOAL):
  * developer → reviewer : reviewer is NOT yet registered (DAG: reviewer
    depends on developer) → deterministic 'unavailable' cost-0 fallback,
    and the 3rd question deterministically hits the hard cap → 'limit'.
  * reviewer → security : both tasks run CONCURRENTLY (both depend on
    developer) → the real answered path (1 model call) or, if the target
    never reaches a tool boundary in time, the 30s 'timeout' cost-0 fallback.

Verdict exit codes:
  0 = CONFIRME (>=1 answered exchange captured with Q/A + stats formula match)
  5 = CONFIRME PARTIELlement (wiring proven, cost-0 fallbacks proven,
      answered path not reached — see evidence)
  4 = INFIRME (teamMode never activated / no exchange traced / formula mismatch)
  2 = setup failure   3 = session error
"""
import glob
import json
import os
import selectors
import subprocess
import sys
import time

BINARY = sys.argv[1] if len(sys.argv) > 1 else "/Applications/Open Cowork.app/Contents/MacOS/Open Cowork"
E2E_DIR = os.path.expanduser("~/Documents/ProjetsGithub/Cowork-e2e-teammate")
WORKDIR = os.path.join(E2E_DIR, "workspace")

USER_DATA_CANDIDATES = [
    os.path.expanduser("~/Library/Application Support/open-cowork"),
    os.path.expanduser("~/Library/Application Support/Open Cowork"),
]

# Bloc propagated: architect → developer (dependency context) → reviewer+security
BLOC = (
    "---BLOC-INSTRUCTIONS-E2E---\n"
    "DEVELOPPEUR : ta TRES premiere action, avant toute lecture ou ecriture, est d'appeler "
    "ask_teammate TROIS FOIS vers target_role=\"reviewer\" avec les questions exactes "
    "Q1=\"E2E-Q1: nom exact de la fonction d'accueil ?\", "
    "Q2=\"E2E-Q2: confirme le nom exact de la fonction d'accueil ?\", "
    "Q3=\"E2E-Q3: une derniere confirmation du nom exact ?\". "
    "N'invente jamais ce nom. PUIS, recopie ce meme BLOC-INSTRUCTIONS-E2E au DEBUT de ton "
    "RAPPORT FINAL (le reviewer et le security le liront).\n"
    "REVIEWER : ta TOUTE PREMIERE action, avant tout travail, est d'appeler ask_teammate une "
    "fois vers target_role=\"security\" avec la question exacte "
    "\"E2E-REVIEWER: quel nom exact de fonction recommandes-tu pour greeter.ts ? Reponds par un seul nom.\" "
    "Ne le devine pas.\n"
    "SECURITY : N'APPELLE PAS ask_teammate (tu es cible, pas demandeur). Reponds simplement si "
    "on te pose une question.\n"
    "ARCHITECTE : aucun coequipier n'est inscrit pendant ta tache — N'APPELLE PAS ask_teammate.\n"
    "---FIN-BLOC---"
)

GOAL = (
    "Objectif E2E : creer le fichier greeter.ts dans le workspace avec une fonction "
    "d'accueil exportee, puis verifier le canal opt-in ask_teammate entre coequipiers. "
    "Suis imperativement le bloc d'instructions suivant pour chaque role.\n\n" + BLOC
)

PROMPT = (
    "TEST E2E OBLIGATOIRE — execute exactement ceci, sans rien ajouter ni modifier :\n"
    "1. Appelle l'outil orchestrate_multi_agent_plan UNE SEULE fois avec les parametres "
    "literaux : teamMode=true, crossVerification=false, aggregationPolicy=\"fail-all\", "
    "et goal = le texte GOAL ci-dessous, recopie mot pour mot SANS resume :\n"
    "---GOAL---\n" + GOAL + "\n---FIN-GOAL---\n"
    "2. Quand le resultat de l'outil revient, termine ta reponse en recopiant INTEGRALEMENT "
    "toute la section qui commence par '### Teammate questions (opt-in)' (y compris les "
    "lignes 'Q:' et 'A:'). Si cette section n'existe pas dans le resultat, ecris litteralement "
    "'SECTION TEAMMATE ABSENTE'.\n"
    "3. N'execute aucun autre outil avant/apres, ne pose aucune question."
)

os.makedirs(WORKDIR, exist_ok=True)  # must exist BEFORE Popen sets it as cwd

proc = subprocess.Popen(
    [BINARY, "--headless", "--mode", "rpc", "--auto-approve", "--cwd", WORKDIR],
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
session_id = None
rpc_results = {}
events_raw = []
run_started_at = time.time()


def send(event):
    line = json.dumps(event)
    proc.stdin.write(line + "\n")
    proc.stdin.flush()


def read_line(timeout):
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
        if etype == "rpc.error":
            print(f"[rpc.error] {json.dumps(event, ensure_ascii=False)[:400]}")
        if etype == "error":
            print(f"[error] {json.dumps(event, ensure_ascii=False)[:400]}")
        if predicate(etype, event):
            return event
    raise TimeoutError(label)


def get_stats():
    send({"type": "backgroundTasks.getStats", "payload": {}})
    wait_for(lambda t, e: t == "rpc.result" and e.get("eventType") == "backgroundTasks.getStats", 60, "stats rpc")
    return rpc_results.get("backgroundTasks.getStats") or {}


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
    """[OneShot] lines written since the run started (responder + title-gen)."""
    out = []
    for base in USER_DATA_CANDIDATES:
        for p in sorted(glob.glob(os.path.join(base, "logs", "app-*.log")), key=os.path.getmtime):
            if p in before_snap and before_snap[p] >= run_started_at - 1:
                continue  # untouched since baseline
            try:
                with open(p, encoding="utf-8", errors="replace") as fh:
                    for line in fh:
                        if "[OneShot]" in line and line.startswith("[") :
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


SECTION_RE = __import__("re").compile(
    r"-\s*\[\s*(answered|timeout|unavailable|limit)\s*\]\s+(\w+)\s+→\s+(\w+)\s+\((\d+)ms,\s*(\d+)\s+model calls?\)"
)


def parse_exchanges(text_blob):
    """Extract every exchange line + its Q:/A: from any text that carries the section."""
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


def fail(code, reason, artifacts):
    print(f"\nE2E FAIL — {reason}")
    print("Artifacts:", ", ".join(artifacts))
    sys.exit(code)


# ---------------------------------------------------------------------------

os.makedirs(WORKDIR, exist_ok=True)
print(f"[e2e] binary: {BINARY}")
print(f"[e2e] workdir: {WORKDIR}")
logs_before = snapshot_logs()

print("[e2e] waiting for headless.ready …")
try:
    wait_for(lambda t, e: t == "headless.ready", 300, "headless.ready")
except TimeoutError as exc:
    fail(2, f"startup timeout ({exc})", [])

print("[e2e] baseline swarm stats …")
stats_before_rpc = get_stats().get("swarm") or {}
stats_file_before, stats_file_before_raw = read_swarm_stats_file()
print(f"[e2e] stats before (rpc): teammateSwarms={stats_before_rpc.get('teammateSwarms')} "
      f"teammateCalls={stats_before_rpc.get('teammateCalls')} totalSwarms={stats_before_rpc.get('totalSwarms')}")

run_started_at = time.time()
logs_before = snapshot_logs()

print("[e2e] starting session (forced orchestrate_multi_agent_plan, teamMode=true) …")
send({
    "type": "session.start",
    "payload": {"title": "Preuve E2E ask_teammate", "prompt": PROMPT, "cwd": WORKDIR},
})

try:
    wait_for(
        lambda t, e: (t == "session.status" and e.get("status") in ("idle", "completed", "error")),
        2400,
        "session completion",
    )
except TimeoutError:
    try:
        proc.stdin.close()
    except Exception:
        pass
    fail(3, "session never reached idle/completed within 2400s", [])

session_errored = session_status == "error"
elapsed = time.time() - run_started_at
print(f"[e2e] session finished status={session_status} sid={session_id} in {elapsed:.0f}s")

messages_blob = ""
trace_steps = []
if session_id:
    try:
        send({"type": "session.getMessages", "payload": {"sessionId": session_id}})
        wait_for(lambda t, e: t == "rpc.result" and e.get("eventType") == "session.getMessages", 60, "getMessages")
        msgs = rpc_results.get("session.getMessages") or []
        messages_blob = json.dumps(msgs, ensure_ascii=False)
        print(f"[e2e] fetched {len(msgs)} stored messages")
    except Exception as exc:  # noqa: BLE001
        print(f"[e2e] getMessages failed: {exc}")
    try:
        send({"type": "session.getTraceSteps", "payload": {"sessionId": session_id}})
        wait_for(lambda t, e: t == "rpc.result" and e.get("eventType") == "session.getTraceSteps", 60, "getTraceSteps")
        trace_steps = rpc_results.get("session.getTraceSteps") or []
    except Exception as exc:  # noqa: BLE001
        print(f"[e2e] getTraceSteps failed: {exc}")

stats_after_rpc = (get_stats().get("swarm") or {})
stats_file_after_path, stats_file_after = read_swarm_stats_file()
oneshot_lines = collect_oneshot_lines(logs_before)

# Housekeeping: remove the proof session so the sidebar keeps no E2E leftover.
try:
    if session_id:
        send({"type": "session.delete", "payload": {"sessionId": session_id}})
        wait_for(lambda t, e: t == "rpc.result" and e.get("eventType") == "session.delete", 30, "session.delete")
except Exception as exc:  # noqa: BLE001
    print(f"[e2e] (housekeeping skipped: {exc})")

try:
    proc.stdin.close()
except Exception:
    pass
try:
    proc.wait(timeout=30)
except Exception:
    proc.kill()

# ------------------------------------------------------------------ evidence

assistant_blob = "\n".join(assistant_text)
tool_names = [s.get("toolName") for s in trace_steps if isinstance(s, dict)]
orchestrate_called = "orchestrate_multi_agent_plan" in tool_names or "Multi-Agent Swarm executed" in assistant_blob

blob = "\n".join([assistant_blob, messages_blob, json.dumps(events_raw, ensure_ascii=False)])
exchanges = parse_exchanges(blob)

d_swarms = (stats_after_rpc.get("teammateSwarms") or 0) - (stats_before_rpc.get("teammateSwarms") or 0)
d_calls = (stats_after_rpc.get("teammateCalls") or 0) - (stats_before_rpc.get("teammateCalls") or 0)
file_d_swarms = (stats_file_after.get("teammateSwarms") or 0) - (stats_file_before_raw.get("teammateSwarms") or 0)
file_d_calls = (stats_file_after.get("teammateCalls") or 0) - (stats_file_before_raw.get("teammateCalls") or 0)

sum_model_calls = sum(e["modelCalls"] for e in exchanges)
by_status = {}
for e in exchanges:
    by_status[e["status"]] = by_status.get(e["status"], 0) + 1
answered = by_status.get("answered", 0)

report = {
    "binary": BINARY,
    "sessionStatus": session_status,
    "elapsedSec": round(elapsed, 1),
    "orchestrateCalled": orchestrate_called,
    "traceToolNames": tool_names,
    "statsBefore": stats_before_rpc,
    "statsAfter": stats_after_rpc,
    "statsFile": stats_file_after_path,
    "deltaTeammateSwarmsRpc": d_swarms,
    "deltaTeammateCallsRpc": d_calls,
    "deltaTeammateSwarmsFile": file_d_swarms,
    "deltaTeammateCallsFile": file_d_calls,
    "exchanges": exchanges,
    "exchangesByStatus": by_status,
    "sumParsedModelCalls": sum_model_calls,
    "oneshotLogLines": oneshot_lines,
    "sectionPresent": "Teammate questions (opt-in)" in blob,
    "sectionAbsentMarker": "SECTION TEAMMATE ABSENTE" in assistant_blob,
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

print("\n===== ASSISTANT ANSWER (tail) =====")
print(assistant_blob[-3000:])
print("===================================\n")
print(f"[e2e] orchestrate called      : {orchestrate_called}")
print(f"[e2e] stats delta (rpc)       : teammateSwarms +{d_swarms}, teammateCalls +{d_calls}")
print(f"[e2e] stats delta (file)      : teammateSwarms +{file_d_swarms}, teammateCalls +{file_d_calls}")
print(f"[e2e] exchanges parsed        : {len(exchanges)} {by_status} sum(modelCalls)={sum_model_calls}")
print(f"[e2e] section present in text : {report['sectionPresent']}")
print(f"[e2e] [OneShot] log lines     : {len(oneshot_lines)}")
for line in oneshot_lines[-8:]:
    print("   ", line[:220])

# ------------------------------------------------------------------- verdict

if session_errored:
    fail(3, "session ended in error", artifacts)

if not orchestrate_called:
    fail(4, "orchestrate_multi_agent_plan was never called — teamMode never activated", artifacts)

if d_swarms < 1:
    fail(4, "swarm_stats teammateSwarms delta = 0 — team mode not recorded "
            "(orchestrate result: see assistant.txt)", artifacts)

if not exchanges:
    if d_calls >= 1:
        print(f"\\nE2E CONFIRME PARTIELLEMENT — stats prove {d_calls} answered exchange(s) "
              f"(teammateSwarms +{d_swarms}) but NO Q/A payload was captured in the streamed "
              f"assistant text nor in stored messages — the assistant did not copy the section. "
              f"Cost-0/fallback statuses unverifiable this run. See {artifacts}")
        sys.exit(5)
    fail(4, "no teammate exchange at all: ask_teammate was never invoked (or team palette missing) "
            "— see report.json + assistant.txt", artifacts)

if d_calls != sum_model_calls or file_d_calls != sum_model_calls:
    fail(4, f"cost formula mismatch: rpc delta={d_calls}, file delta={file_d_calls}, "
            f"parsed sum={sum_model_calls} — swarm-stats.ts aggregation broken", artifacts)

if answered >= 1:
    with_qa = sum(1 for e in exchanges if e["question"] and e["answer"])
    print(f"\nE2E CONFIRME — {answered} answered exchange(s), {with_qa} captured with Q/A payload, "
          f"stats formula exact (teammateCalls +{d_calls} == sum(modelCalls)), "
          f"fallbacks: {by_status}.")
    if by_status.get("unavailable") or by_status.get("timeout") or by_status.get("limit"):
        print(f"   Cost-0 fallbacks also proven: {by_status} (modelCalls contributed only by answered).")
    sys.exit(0)

print(f"\nE2E CONFIRME PARTIELLEMENT — wiring + stats proven (teammateSwarms +{d_swarms}), "
      f"cost-0 fallbacks observed: {by_status}, but NO answered exchange (target never reached "
      f"a boundary within TEAMMATE_QUESTION_TIMEOUT_MS=30000 in this run). "
      f"See {artifacts}")
sys.exit(5)
