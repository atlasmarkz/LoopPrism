#!/usr/bin/env python3
"""Dump what the Python session core derives from each session, for the Node parity test.

    python scripts/parity_dump.py sessions.json > python.jsonl

``sessions.json`` is a list of ``[path, agent]``. Each output line is one session: its meta,
events (text as a hash), steps, stats, findings, timing, cost, context trend, a few step
contexts, the agent tree and the optimize findings. npm/parity/dump.js writes the same
shape from the Node core; npm/parity/compare.js runs both and diffs them.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from loopprism.optimize.rules import RULES  # noqa: E402
from loopprism.sessions import actions, agents, analysis, context  # noqa: E402
from loopprism.sessions.store import SessionStore  # noqa: E402


def h(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", "surrogatepass")).hexdigest()[:16]


def picked_steps(ps) -> list[int]:
    real = [s.index for s in ps.steps if s.model != "<synthetic>"]
    if len(real) <= 6:
        return real
    return sorted({real[0], real[1], real[len(real) // 2], real[-2], real[-1]})


def dump(path: str, agent: str) -> dict:
    ps = SessionStore._parser(agent).parse(path)
    out: dict = {"path": path, "agent": agent}
    out["meta"] = ps.meta.to_dict()
    events = []
    for e in ps.events:
        d = e.to_dict()
        d["text"] = h(d["text"])
        events.append(d)
    out["events"] = events
    steps = []
    for s in ps.steps:
        d = dataclasses.asdict(s)
        d["refs"] = None if s.refs is None else [len(s.refs), h("|".join(s.refs))]
        steps.append(d)
    out["steps"] = steps
    out["search"] = h(ps.search_text)
    out["unresolved"] = ps.unresolved
    out["pool"] = len(ps.pool)
    out["shapes"] = sorted(ps.shapes)
    out["stats"] = context.stats(ps)
    out["findings"] = analysis.findings(ps)
    out["timing"] = analysis.timing(ps)
    out["cost"] = analysis.cost_breakdown(ps)
    out["trend"] = context.trend(ps)
    ctx = []
    for i in picked_steps(ps):
        c = context.step_context(ps, i, detail=True)
        c["items"] = {k: [[x["label"], x["tokens"], h(x["preview"])] for x in v] for k, v in c["items"].items()}
        ctx.append(c)
    out["step_context"] = ctx
    out["agents"] = agents.build(ps)
    for a in out["agents"]["agents"]:
        for k in ("task", "result"):
            if a.get(k):
                a[k]["text"] = h(a[k]["text"])
    out["export"] = h(actions.export_markdown(ps))
    found = []
    for rule in RULES:
        for f in rule(ps):
            found.append([f.rule, f.saving, f.detail, f.confidence])
    out["optimize"] = sorted(found, key=lambda x: (x[0], x[2]))
    return out


def main() -> None:
    with open(sys.argv[1], encoding="utf-8") as fh:
        todo = json.load(fh)
    for path, agent in todo:
        try:
            rec = dump(path, agent)
        except Exception as err:  # reported, compared like any other output
            rec = {"path": path, "agent": agent, "error": f"{type(err).__name__}: {err}"}
        sys.stdout.write(json.dumps(rec, ensure_ascii=False, default=str) + "\n")


if __name__ == "__main__":
    main()
