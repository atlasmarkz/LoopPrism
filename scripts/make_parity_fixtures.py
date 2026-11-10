#!/usr/bin/env python3
"""Write made-up sessions of every supported agent under one folder, for the Node parity test in CI.

    python scripts/make_parity_fixtures.py /tmp/lp-fixtures
    eval "$(python scripts/make_parity_fixtures.py /tmp/lp-fixtures --env)"   # the roots, as env vars

Reuses the fixtures of the Python test suite and the demo generator, so both cores are compared
on the same shapes the tests already cover: Claude Code (exact requests, subagents, a loop),
Codex, DeepSeek Harness (zstd frames), WorkBuddy, OpenCode, Gemini CLI (JSONL with patches,
and the legacy JSON document) and Cursor (both database layouts).
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))


def env(root: str) -> dict[str, str]:
    return {
        "CLAUDE_CONFIG_DIR": os.path.join(root, ".claude"),
        "CODEX_HOME": os.path.join(root, ".codex"),
        "DSH_HOME": os.path.join(root, ".dsh"),
        "DSH_DESKTOP_HOME": os.path.join(root, "no-dsh-desktop"),
        "WORKBUDDY_CONFIG_DIR": os.path.join(root, ".workbuddy"),
        "XDG_DATA_HOME": root,
        "GEMINI_CLI_HOME": root,
        "CURSOR_USER_DIR": os.path.join(root, "Cursor", "User"),
    }


def write(root: str) -> None:
    for p in (os.path.join(HERE, "..", "src"), os.path.join(HERE, ".."), HERE):
        sys.path.insert(0, p)
    import make_demo_sessions
    from tests import support_agents, support_other_agents
    from tests.test_cursor import make_db
    from tests.test_gemini import HEADER, messages

    make_demo_sessions.main(root)
    support_agents.write(root)
    support_other_agents.write(root)
    support_other_agents.write_opencode(root)

    chats = Path(root, ".gemini", "tmp", "myproj", "chats")
    chats.mkdir(parents=True, exist_ok=True)
    Path(root, ".gemini", "tmp", "myproj", ".project_root").write_text("/work/myproj\n")
    rows = [HEADER, *messages(),
            {"$patch": {"id": "m4", "content": "Fixed, and tested."}},
            {"$patch": {"updates": [{"id": "m2", "toolCalls": [{"id": "c1", "result": [{"functionResponse": {"response": {"output": "all passed"}}}]}]}]}},
            {"$set": {"summary": "Fixing the test"}}]
    (chats / "session-patched.jsonl").write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    rewound = [{**HEADER, "sessionId": "sess-2"}, *messages(), {"$rewindTo": "m4"}]
    (chats / "session-rewound.jsonl").write_text("\n".join(json.dumps(r) for r in rewound) + "\n")
    legacy = {**HEADER, "sessionId": "sess-3", "lastUpdated": "2026-10-01T10:00:10.000Z", "messages": messages()}
    (chats / "session-legacy.json").write_text(json.dumps(legacy))

    make_db(Path(root, "Cursor", "User"))


if __name__ == "__main__":
    root = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/tmp/lp-fixtures")
    if "--env" in sys.argv:
        print("\n".join(f"export {k}='{v}'" for k, v in env(root).items()))
    else:
        write(root)
