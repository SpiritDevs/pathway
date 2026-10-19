// Explicit opt-in integration verification. Uses only a loopback fixture and a temporary profile.
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalConsole:off - Native adapter integration test.
import * as NodeAssert from "node:assert/strict";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import { ThreadId, type PreviewAutomationOperation } from "@spiritdevs/contracts";
import { RemoteBrowserRuntime } from "../src/preview/RemoteBrowserRuntime.ts";

const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-browser-proof-"));
const fixture = NodeHttp.createServer((request, response) => {
  response.setHeader("content-type", "text/html");
  response.end(`<!doctype html><title>Pathway browser verification</title><style>body{font:24px system-ui;padding:30px}input{display:block;margin:10px}</style>
<h1>${request.url === "/popup" ? "Popup works" : "Isolated browser fixture"}</h1>
<form onsubmit="event.preventDefault();document.querySelector('h1').textContent='Signed in'"><label>Username<input name="username" autocomplete="username"></label><label>Password<input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>
<a href="/popup" target="_blank">New tab</a>`);
});
await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
const address = fixture.address();
NodeAssert.ok(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
const threadId = ThreadId.make(`browser-proof-${NodeCrypto.randomUUID()}`);
const runtime = new RemoteBrowserRuntime(
  NodePath.join(directory, "browser"),
  NodePath.join(directory, "attachments"),
);
const cleanups: Array<() => Promise<void>> = [];
try {
  NodeAssert.equal((await runtime.list(threadId)).tabs.length, 0);
  let observedTabs = 0;
  cleanups.push(
    await runtime.subscribe(threadId, undefined, (frame) => {
      observedTabs = frame.tabs?.length ?? observedTabs;
    }),
  );
  const opened = await runtime.command({ action: "open", threadId, url: origin });
  const tabId = opened.selectedTabId!;
  NodeAssert.ok(tabId);
  NodeAssert.equal(observedTabs, 1);
  const automate = (operation: PreviewAutomationOperation, input: unknown) =>
    runtime.automate({
      requestId: NodeCrypto.randomUUID(),
      threadId,
      tabId,
      operation,
      input,
      timeoutMs: 10_000,
    });
  const firstFrame = Promise.withResolvers<void>();
  cleanups.push(
    await runtime.subscribe(threadId, tabId, (frame) => {
      if (frame.data) {
        NodeAssert.equal(frame.width, 1280);
        firstFrame.resolve();
      }
    }),
  );
  await firstFrame.promise;
  await runtime.command({
    action: "autofill",
    threadId,
    tabId,
    origin,
    username: "synthetic-user",
    password: "synthetic-test-password",
  });
  const filled = await automate("evaluate", {
    expression:
      "({username:document.querySelector('[name=username]').value,hasPassword:document.querySelector('[name=password]').value.length>0,submitted:document.querySelector('h1').textContent==='Signed in'})",
  });
  NodeAssert.deepEqual(filled, { username: "synthetic-user", hasPassword: true, submitted: false });
  await NodeAssert.rejects(
    runtime.command({
      action: "autofill",
      threadId,
      tabId,
      origin: "https://wrong.example",
      username: "unused",
      password: "unused",
    }),
    /origin changed/,
  );
  const popupArrived = Promise.withResolvers<void>();
  cleanups.push(
    await runtime.subscribe(threadId, undefined, (frame) => {
      if (frame.tabs?.some((tab) => tab.openerTabId === tabId && tab.url.endsWith("/popup")))
        popupArrived.resolve();
    }),
  );
  await automate("click", { selector: "a[target=_blank]" });
  await popupArrived.promise;
  NodeAssert.equal((await runtime.list(threadId)).tabs.length, 2);
  const blankPopupArrived = Promise.withResolvers<void>();
  cleanups.push(
    await runtime.subscribe(threadId, undefined, (frame) => {
      if (
        frame.tabs?.some((tab) => tab.openerTabId === tabId && tab.url.endsWith("/popup?blank=1"))
      )
        blankPopupArrived.resolve();
    }),
  );
  await automate("evaluate", {
    expression:
      "(() => {const popup=window.open('');popup.location.href='/popup?blank=1';return true})()",
  });
  await blankPopupArrived.promise;
  NodeAssert.equal((await runtime.list(threadId)).tabs.length, 3);
  const screenshot = await runtime.command({ action: "screenshot", threadId, tabId });
  NodeAssert.ok(screenshot.artifact && screenshot.artifact.sizeBytes > 100);
  NodeAssert.equal(
    (await NodeFSP.readFile(screenshot.artifact.path)).subarray(1, 4).toString(),
    "PNG",
  );
  await runtime.command({ action: "recordingStart", threadId, tabId });
  await automate("evaluate", {
    expression:
      "new Promise(resolve=>{let n=0;const t=setInterval(()=>{document.querySelector('h1').textContent='Capture frame '+(++n);if(n===12){clearInterval(t);resolve(n)}},100)})",
  });
  const video = await runtime.command({ action: "recordingStop", threadId, tabId });
  NodeAssert.ok(
    video.artifact && video.artifact.mimeType === "video/mp4" && video.artifact.sizeBytes > 100,
  );
  NodeAssert.equal((await NodeFSP.readFile(video.artifact.path)).subarray(4, 8).toString(), "ftyp");
  const duration = Number(
    NodeChildProcess.execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        video.artifact.path,
      ],
      { encoding: "utf8" },
    ).trim(),
  );
  NodeAssert.ok(
    duration >= 0.9 && duration <= 3,
    `Recording duration must match capture time; got ${duration}s`,
  );
  await runtime.command({ action: "close", threadId, tabId });
  NodeAssert.equal((await runtime.list(threadId)).tabs.length, 2);
  console.log(
    JSON.stringify(
      {
        outcome: "passed",
        directory,
        screenshot: screenshot.artifact.path,
        video: video.artifact.path,
        checks: [
          "lazy metadata",
          "first frame",
          "autofill origin",
          "no auto-submit",
          "popup opener",
          "blank popup navigation",
          "screenshot",
          "MP4 recording",
          "close",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
  await runtime.close();
  await new Promise<void>((resolve, reject) =>
    fixture.close((error) => (error ? reject(error) : resolve())),
  );
}
