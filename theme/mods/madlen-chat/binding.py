"""Read the selected agent's last 50 conversation messages without terminal input."""
import json
from pathlib import Path
import re
import sqlite3
import subprocess

LIMIT = 50


def run(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=8)


def database(path):
    return sqlite3.connect(f"{Path(path).as_uri()}?mode=ro", uri=True, timeout=2)


def normalize(text):
    return re.sub(r"\s+", " ", str(text)).strip()


def process_stream(pid, root):
    """Only this TUI process's stream; a shared daemon's stream would mix sessions."""
    path = root / "logs_2.sqlite"
    if not path.exists():
        return ""
    with database(path) as db:
        row = db.execute("SELECT process_uuid FROM logs WHERE process_uuid GLOB ? ORDER BY id DESC LIMIT 1",
                         (f"pid:{int(pid)}:*",)).fetchone()
        if not row:
            return ""
        rows = db.execute("SELECT feedback_log_body FROM logs WHERE process_uuid=? AND target=? ORDER BY id DESC LIMIT 1600",
                          (row[0], "codex_tui::markdown_stream")).fetchall()
    chunks = []
    for (body,) in reversed(rows):
        if body and body.startswith("push_delta: "):
            try:
                value = json.loads(body[len("push_delta: "):])
                if isinstance(value, str):
                    chunks.append(value)
            except ValueError:
                pass
    return normalize("".join(chunks))[-5000:]


def bind_text(candidates, stream, screen):
    """Unique matching text is required. Never choose by folder or modification time."""
    for evidence_index, evidence in enumerate((normalize(stream), normalize(screen))):
        if len(evidence) < 80:
            continue
        needles = {evidence[i:i + 100] for i in range(max(0, len(evidence) - 2400), len(evidence) - 99, 50)}
        if not needles:
            needles = {evidence[-80:]}
        scores = []
        for candidate, texts in candidates:
            haystack = "\n".join(normalize(t) for t in texts)
            # Old matching messages must not bind a newly switched/streaming conversation.
            if evidence_index == 0 and evidence[-80:] not in haystack:
                continue
            score = sum(needle in haystack for needle in needles)
            if score:
                scores.append((score, candidate))
        scores.sort(key=lambda x: x[0], reverse=True)
        if scores and (len(scores) == 1 or scores[0][0] > scores[1][0]):
            return scores[0][1]
    return None


def bind_recent(candidates, stream, screen):
    """Short replies still require a process-specific suffix AND two screen matches.

    Never bind a lone greeting or pick an ambiguous copy of a conversation.
    """
    stream, screen = normalize(stream), normalize(screen)
    scores = []
    for candidate, texts in candidates:
        snippets = set(normalize(t) for t in texts if len(normalize(t)) >= 20)
        if not any(stream.endswith(t) for t in snippets):
            continue
        matches = [t for t in snippets if t in screen]
        if len(matches) >= 2:
            scores.append((sum(min(len(t), 200) for t in matches), candidate))
    scores.sort(reverse=True)
    if scores and (len(scores) == 1 or scores[0][0] > scores[1][0]):
        return scores[0][1]
    return None


def codex_thread(pid, root, screen):
    state = root / "state_5.sqlite"
    projection = root / "thread_history_1.sqlite"
    if not state.exists() or not projection.exists():
        return None
    stream = process_stream(pid, root)
    with database(state) as db:
        rows = db.execute("SELECT id,rollout_path,cwd FROM threads WHERE archived=0 ORDER BY updated_at DESC LIMIT 80").fetchall()
    candidates, details = [], {}
    with database(projection) as db:
        for sid, path, cwd in rows:
            texts = [row[0] or "" for row in db.execute(
                "SELECT json_extract(item_json,'$.text') FROM thread_items WHERE thread_id=? AND item_type='agentMessage' ORDER BY rollout_ordinal DESC LIMIT 50", (sid,))]
            # A new session may have only a short greeting. Its long user prompt
            # can still establish a unique match to this process's visible screen.
            user_rows = db.execute("SELECT item_json FROM thread_items WHERE thread_id=? AND item_type='userMessage' ORDER BY rollout_ordinal DESC LIMIT 10", (sid,)).fetchall()
            for (raw,) in user_rows:
                texts.extend(c.get("text", "") for c in json.loads(raw).get("content", []) if c.get("type") == "text")
            if texts:
                candidates.append((sid, texts))
                details[sid] = (sid, path, cwd)
    sid = bind_text(candidates, stream, screen) or bind_recent(candidates, stream, screen)
    return details.get(sid)


def strings(value):
    """Text and path fields, excluding embedded image data."""
    if isinstance(value, str):
        if len(value) < 2_000_000 and not value.startswith("data:"):
            yield value
    elif isinstance(value, list):
        for part in value:
            yield from strings(part)
    elif isinstance(value, dict):
        for key, part in value.items():
            if key not in {"result", "revisedPrompt", "summary", "encrypted_content", "image_url", "data", "diff", "inputImages"}:
                yield from strings(part)


def item_text(item):
    kind = item.get("type")
    if kind == "agentMessage":
        return item.get("text", "")
    if kind == "imageGeneration":
        return item.get("savedPath") or ""
    if kind == "commandExecution":
        # Commands and source files read during a task are not produced artifacts.
        # Final file links and structured generation/file-change records cover outputs.
        return ""
    if kind == "mcpToolCall":
        return "\n".join(strings(item.get("result") or {}))
    if kind == "fileChange":
        return "\n".join(c.get("path", "") for c in item.get("changes", []))
    if kind == "userMessage":
        return ""
    if kind == "imageView":
        return ""
    return ""


def projected_messages(root, sid, cwd, limit=LIMIT, message_id=None):
    with database(root / "thread_history_1.sqlite") as db:
        if message_id is not None:
            rows = db.execute("""SELECT rollout_ordinal,created_at_ms,item_json FROM thread_items
                WHERE thread_id=? AND item_type='agentMessage'
                AND CAST(COALESCE(NULLIF(json_extract(item_json,'$.id'),''),rollout_ordinal) AS TEXT)=?""",
                (sid, message_id)).fetchall()
            return [dict(text=json.loads(raw).get('text',''),cwd=json.loads(raw).get('cwd') or cwd,
                         ordinal=ordinal,at=at) for ordinal,at,raw in rows],len(rows)
        bounds = db.execute("SELECT rollout_ordinal FROM thread_items WHERE thread_id=? AND item_type IN ('userMessage','agentMessage') ORDER BY rollout_ordinal DESC LIMIT ?", (sid, limit)).fetchall()
        if not bounds:
            return [], 0
        rows = db.execute("""SELECT rollout_ordinal,created_at_ms,
            CASE WHEN item_type='imageGeneration' THEN json_remove(item_json,'$.result','$.revisedPrompt','$.inputImages') ELSE item_json END
            FROM thread_items WHERE thread_id=? AND rollout_ordinal>=? AND item_type!='reasoning'
            ORDER BY rollout_ordinal DESC""", (sid, bounds[-1][0])).fetchall()
    messages = []
    for ordinal, at, raw in rows:
        item = json.loads(raw)
        text = item_text(item)
        if text:
            messages.append(dict(text=text, cwd=item.get("cwd") or cwd, ordinal=ordinal, at=at))
    return messages, len(bounds)


def process_family(pid):
    rows = run(["ps", "-axo", "pid=,ppid="]).stdout.splitlines()
    children = {}
    for row in rows:
        parts = row.split()
        if len(parts) == 2:
            children.setdefault(int(parts[1]), []).append(int(parts[0]))
    family, pending = [], [int(pid)]
    while pending and len(family) < 40:
        child = pending.pop()
        if child in family:
            continue
        family.append(child)
        pending.extend(children.get(child, []))
    return family


def exact_log(pid, kind, home):
    for child in process_family(pid):
        if kind == "claude":
            meta = home / ".claude/sessions" / f"{child}.json"
            if meta.exists():
                sid = json.loads(meta.read_text()).get("sessionId")
                if sid and re.fullmatch(r"[\da-fA-F-]{36}", sid):
                    matches = list((home / ".claude/projects").glob(f"*/{sid}.jsonl"))
                    if len(matches) == 1:
                        return matches[0]
        else:
            # A daemon can hold several other clients' files: never pick its first log.
            command = run(["ps", "-p", str(child), "-o", "args="]).stdout
            if "app-server" in command and "--managed-daemon" in command:
                continue
            result = run(["lsof", "-p", str(child), "-Fn"])
            paths = [Path(line[1:]) for line in result.stdout.splitlines()
                     if line.startswith("n/") and "/rollout-" in line and line.endswith(".jsonl")]
            if len(paths) == 1:
                return paths[0]
    return None


def reverse_json(path):
    with open(path, "rb") as file:
        file.seek(0, 2)
        pos, carry = file.tell(), b""
        while pos:
            size = min(pos, 65536)
            pos -= size
            file.seek(pos)
            parts = (file.read(size) + carry).split(b"\n")
            carry = parts.pop(0)
            for part in reversed(parts):
                if part:
                    try:
                        yield json.loads(part)
                    except (ValueError, UnicodeDecodeError):
                        pass
        if carry:
            try:
                yield json.loads(carry)
            except (ValueError, UnicodeDecodeError):
                pass


def log_messages(path, kind, cwd, limit=LIMIT, message_id=None):
    messages, count = [], 0
    for ordinal, record in enumerate(reverse_json(path)):
        if message_id is not None and str(record.get('uuid') or ordinal) != message_id:
            continue
        text, chat = "", False
        if kind == "codex":
            if record.get("type") != "response_item":
                continue
            payload = record.get("payload", {})
            typ = payload.get("type")
            chat = typ == "message" and payload.get("role") in {"user", "assistant"}
            if chat and payload.get("role") == "assistant":
                text = "\n".join(strings(payload.get("content", [])))
            elif typ in {"custom_tool_call_output", "function_call_output"}:
                text = "\n".join(strings(payload.get("output", "")))
            elif typ == "image_generation_call":
                text = payload.get("saved_path") or ""
        else:
            if record.get("isSidechain"):
                continue
            payload = record.get("message", {})
            if payload.get("role") not in {"user", "assistant"}:
                continue
            content = payload.get("content", [])
            if isinstance(content, str):
                content = [{"type": "text", "text": content}]
            chat = any(c.get("type") == "text" for c in content if isinstance(c, dict))
            # User/tool-result records still count toward the same 50-message window.
            if payload.get("role") == "assistant":
                outputs = [c for c in content if isinstance(c, dict) and (c.get("type") == "text" or
                    (c.get("type") == "tool_use" and c.get("name") in {"Write", "Edit", "MultiEdit"}))]
                text = "\n".join(strings(outputs))
        if chat:
            count += 1
        if text:
            messages.append(dict(text=text, cwd=record.get('cwd') or cwd, ordinal=-ordinal, at=record.get("timestamp")))
        if count >= limit:
            break
    return messages, count


def read_history(address, home=None, message_id=None):
    if not address or "/" in address:
        raise ValueError("Bu panel yerel ajanın konuşmasını okuyabilir.")
    home = Path(home or Path.home())
    result = run(["hc", "get", address, "--json"])
    if result.returncode:
        raise ValueError("Seçili ajan bulunamadı.")
    terminal = json.loads(result.stdout)
    fg = terminal.get("foreground") or {}
    pid = fg.get("pid")
    app = (terminal.get("status") or {}).get("app") or fg.get("name", "")
    kind = "codex" if "codex" in app else "claude" if "claude" in app else None
    if not pid or not kind:
        raise ValueError("Son 50 mesaj taraması Codex ve Claude Code oturumlarını destekliyor.")
    cwd = fg.get("cwd") or terminal.get("cwd")
    root = home / ".codex"
    if kind == "codex":
        screen = run(["hc", "read", address, "--lines", "0", "--json"])
        screen_text = json.loads(screen.stdout).get("text", "") if screen.returncode == 0 else ""
        binding = codex_thread(pid, root, screen_text)
        if binding:
            sid, path, initial_cwd = binding
            messages, count = projected_messages(root, sid, initial_cwd or cwd, message_id=message_id)
            return dict(messages=messages, message_count=count, session=sid, kind=kind)
    path = exact_log(pid, kind, home)
    if not path:
        raise ValueError("Seçili ajanın konuşması kesin olarak eşleştirilemedi. Ajanın bir yanıtı göründükten sonra Yenile'ye bas.")
    messages, count = log_messages(path, kind, cwd, message_id=message_id)
    sid = path.stem
    if kind == 'codex':
        try:
            with path.open() as file: meta = json.loads(file.readline())
            if meta.get('type') == 'session_meta':
                sid = (meta.get('payload') or {}).get('id') or sid
        except (OSError, ValueError):
            pass
    return dict(messages=messages, message_count=count, session=sid, kind=kind)
