"""Exercise production controls against the explicitly simulated review fixture.

Start apps/web/evidence/cor96/vite.config.ts first. Set AGENT_BROWSER to the CLI path.
This verifies browser actions and rendering, not Cloud persistence or live providers.
"""

import json
import os
from pathlib import Path
import re
import subprocess

OUT = Path(__file__).resolve().parent
CLI = os.environ.get("AGENT_BROWSER", "agent-browser")


def run(*args):
    return subprocess.check_output(
        [CLI, "--session", "cor96-review", *args], text=True
    ).strip()


def target(role, name, index=0):
    snapshot = run("snapshot", "-i")
    matches = re.findall(
        rf'{role} "{re.escape(name)}"[^\n]*?\[[^\]]*ref=(e\d+)\]', snapshot
    )
    return "@" + matches[index]


def click(name, index=0):
    run("click", target("button", name, index))


def fill(name, value):
    run("fill", target("textbox", name), value)


def evaluate(expression):
    return json.loads(run("eval", f"JSON.stringify({expression})"))


def state():
    return json.loads(evaluate("window.cor96.data()"))


def shot(name):
    run("screenshot", "--full", str(OUT / (name + ".png")))


run("set", "viewport", "1280", "1100")
run("open", "http://127.0.0.1:6273")
run("wait", "button")
click("Worker conversation")
shot("01-question-queue")
fill("Worker follow-up", "Prioritize the failed deployment; pause release-note changes.")
run("select", target("combobox", "Follow-up delivery"), "steer")
shot("02-steering")
click("Send follow-up")
assert state()["messages"][-1]["mode"] == "steer"
click("Edit")
fill("Edit pending follow-up", "Inspect deployment logs before updating the release notes.")
shot("03-edit-queue")
click("Save edit")
assert state()["messages"][0]["revision"] == 1
click("Move up")
assert [m["id"] for m in state()["messages"]][:2] == ["second", "first"]
shot("04-reordered")
click("Remove", 1)
assert "first" not in [m["id"] for m in state()["messages"]]
shot("05-removed")
fill("Should the release report include customer-facing wording?",
     "Yes. Include customer-facing wording, but do not publish it.")
click("Reply to worker")
assert state()["questions"][0]["state"] == "answering"
shot("06-answer-queued")
click("Request stop")
assert "Stop requested" in run("get", "text", "body")
assert "Working" in run("get", "text", "body")
shot("07-stop-requested")
run("eval", "window.cor96.confirmStop()")
assert 'button "Request stop"' not in run("snapshot", "-i")
assert "Cancelled" in run("get", "text", "body")
shot("08-stop-confirmed")
run("set", "viewport", "390", "844")
assert json.loads(evaluate("({width:innerWidth,content:document.documentElement.scrollWidth})")) == {"width":390,"content":390}
shot("09-narrow")
run("set", "viewport", "1280", "1100")
run("eval", "window.cor96.accept()")
assert len(re.findall(r'button "Edit"', run("snapshot", "-i"))) == 1
shot("10-accepted")
run("eval", "window.cor96.deliver()")
shot("11-dispatched")
actions = json.loads(evaluate("window.cor96Actions"))
assert actions[1]["args"]["action"]["revision"] == 0
assert actions[3]["args"]["action"]["revision"] == 1
assert actions[4]["args"]["action"]["questionId"] == "question"
assert actions[4]["args"]["action"]["answers"]["format"].endswith("do not publish it.")
(OUT / "browser-actions.json").write_text(json.dumps(actions, indent=2) + "\n")
(OUT / "browser-result.txt").write_text("PASS: steering, edit revision, complete-set reorder, removal revision, routed answer ID, stop request/terminal rendering, accepted-message freeze, narrow layout.\nSimulated backend; no live provider delivery or stop confirmed by this fixture.\n" + (run("errors") or "No browser page errors.") + "\n")
print("PASS: browser interactions and 11 screenshots captured")
