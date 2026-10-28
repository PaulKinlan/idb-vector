// Adapted from the existing Voicebox tests/lib/cdp.mjs raw-CDP helper.
// tests/lib/cdp.mjs — a browser driver in ~120 lines, on the platform's own primitives.
//
// WHY NOT A FRAMEWORK: the runtime here is zero-dependency by policy, and the acceptance checks
// need exactly four things — launch a browser, open a page, run a script in it, click a real
// control. Node has `WebSocket` and `fetch` built in and Chromium speaks CDP over both, so the
// whole driver is one file with no install step. (Playwright would be a dependency the product
// then depends on being installable, for a test suite that runs on one machine.)
//
// The checks drive REAL input: `click()` dispatches an actual mouse event at the element's
// centre, and `type()` inserts text the way a keyboard does. A test that sets `.value` from
// script would pass through a page whose controls are not wired to anything at all.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const BROWSERS = [
  process.env.IDB_VECTOR_CHROME,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
].filter(Boolean);

// Whether ANY process is still in the group: signal 0 asks the kernel without signalling anything.
// The group outlives the browser this file spawned, which is the whole point - a helper that ignores
// SIGTERM keeps the group alive after the leader has been reaped.
function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Waits for the group to empty AND for the browser to be reaped. Escalating on the browser's exit
// alone is not enough: a helper that survives SIGTERM would then outlive a close() that reported
// success (observed - two helpers did, until this checked the group instead of the leader).
async function waitForGroupGone(pgid, child, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (groupAlive(pgid) === false && (child.exitCode !== null || child.signalCode !== null)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(50);
  }
}

// Sends a signal to the browser's whole process group, falling back to the single process where
// process groups are not available (or the caller passed a child that is not a group leader).
function signalProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

// Terminates the browser AND waits for its whole group to be gone. SIGTERM first so Chrome can shut
// down cleanly, SIGKILL if anything is still in the group afterwards: a signal that is never waited
// for leaves helpers (and the profile directory) behind, which is how the orphans above happened.
async function endProcessGroup(child, { graceMs = 1500, killGraceMs = 2000 } = {}) {
  const pgid = child.pid;
  if (groupAlive(pgid) === false) return;
  signalProcessGroup(child, "SIGTERM");
  if (await waitForGroupGone(pgid, child, graceMs)) return;
  signalProcessGroup(child, "SIGKILL");
  if (await waitForGroupGone(pgid, child, killGraceMs) === false) {
    // Said out loud rather than swallowed: a close() that did not finish the job is worth knowing
    // about, and the caller is about to remove the profile directory.
    console.warn(`chromium process group ${pgid} did not exit; close() left it to the reaper`);
  }
}

// Cold start on a contended 2-vCPU VM measured 53.7s (2026-10-28); 20000ms was failing the full gate
// before test logic even started (idb-vector-kxz2). 120000ms leaves headroom while bounding real hangs.
export const DEVTOOLS_ENDPOINT_TIMEOUT_MS = 120000;

export async function launch({ width = 1000, height = 800, profile = null, fakeMedia = false, browserArgs = ["--disable-gpu"] } = {}) {
  const binary = BROWSERS.find((b) => existsSync(b));
  if (!binary) throw new Error("no Chromium/Chrome binary found; set IDB_VECTOR_CHROME");

  // A caller may hand in a prepared profile — the only way to give the page a REAL platform
  // answer (a blocked permission) rather than a constructed one.
  const ownProfile = !profile;
  profile = profile ?? mkdtempSync(path.join(os.tmpdir(), "idb-vector-cdp-"));
  const child = spawn(
    binary,
    [
      "--headless=new",
      ...(fakeMedia ? ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] : []),
      ...browserArgs,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-dev-shm-usage",
      `--window-size=${width},${height}`,
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    // Spawned detached so Chrome leads its OWN process group (setsid), which is what lets close()
    // signal every helper it starts. Killing only this pid - which is what close() used to do -
    // leaves renderer, GPU, zygote and crashpad helpers reparented and running: one crashpad
    // handler outlived its browser by 46 minutes on this 2-vCPU VM.
    { stdio: ["ignore", "pipe", "pipe"], detached: true },
  );

  const launchStart = Date.now();
  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`chromium did not print a DevTools endpoint after ${Date.now() - launchStart}ms`)),
      DEVTOOLS_ENDPOINT_TIMEOUT_MS,
    );
    let buffer = "";
    const scan = (chunk) => {
      buffer += String(chunk);
      const match = buffer.match(/ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f-]+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    };
    child.stderr.on("data", scan);
    child.stdout.on("data", scan);
    child.on("exit", (code) => reject(new Error(`chromium exited early (${code}) after ${Date.now() - launchStart}ms`)));
  });

  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  const events = [];

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("devtools websocket failed")), { once: true });
  });

  socket.addEventListener("message", (event) => {
    const data = JSON.parse(String(event.data));
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) reject(new Error(`${data.error.message} (${JSON.stringify(data.error.data ?? "")})`));
      else resolve(data.result);
    } else if (data.method) {
      events.push(data);
    }
  });

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);

  // `close()` is the normal path, but a suite can also exit without reaching it: an assertion that
  // throws past the caller's finally, or a plain process.exit(). Because the browser now leads its
  // own process group it no longer goes down with this process's group, so the last thing this
  // process does is signal that group. (A hard kill of the suite is the one case no handler can
  // cover; the reaper is the backstop there.) Added per launch and removed by close(), so a suite
  // that closes its browser adds no listener once it is done.
  const killGroupOnExit = () => signalProcessGroup(child, "SIGKILL");
  process.once("exit", killGroupOnExit);

  const page = {
    sessionId,
    // The Chrome process, which is also its process group id on POSIX because it is spawned
    // detached. Exposed so a test can prove the group is gone after close().
    pid: child.pid,
    send: (method, params) => send(method, params, sessionId),
    async close() {
      try {
        socket.close();
      } catch {}
      await endProcessGroup(child);
      process.off("exit", killGroupOnExit);
      try {
        if (ownProfile) rmSync(profile, { recursive: true, force: true });
      } catch {}
    },
  };

  page.goto = async (url, { timeout = 20000 } = {}) => {
    const loaded = new Promise((resolve) => {
      const started = events.length;
      const tick = setInterval(() => {
        for (let i = started; i < events.length; i++) {
          if (events[i].method === "Page.loadEventFired") {
            clearInterval(tick);
            clearTimeout(timer);
            return resolve(true);
          }
        }
      }, 25);
      const timer = setTimeout(() => {
        clearInterval(tick);
        resolve(false);
      }, timeout);
    });
    await page.send("Page.navigate", { url });
    await loaded;
    await sleep(150);
  };

  /**
   * A device viewport: width, height, DPR-downscaled touch device. Used for the mobile half of a UI
   * check, because "it pushes the page on a phone" is not a claim a desktop window can falsify.
   */
  page.emulateViewport = async ({ width, height, mobile = true, scale = 2 }) => {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: scale,
      mobile,
    });
    if (mobile) await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await sleep(150);
  };

  page.clearViewport = async () => {
    await page.send("Emulation.clearDeviceMetricsOverride");
    await sleep(100);
  };

  page.screenshot = async (filePath, { fullPage = false } = {}) => {
    const params = { format: "png", captureBeyondViewport: fullPage };
    if (fullPage) {
      const metrics = await page.send("Page.getLayoutMetrics");
      const size = metrics.cssContentSize;
      await page.send("Emulation.setDeviceMetricsOverride", {
        width: Math.ceil(size.width),
        height: Math.ceil(size.height),
        deviceScaleFactor: 1,
        mobile: false,
      });
    }
    const { data } = await page.send("Page.captureScreenshot", params);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, Buffer.from(data, "base64"));
    if (fullPage) await page.send("Emulation.clearDeviceMetricsOverride");
    return filePath;
  };

  /** Run a function in the page and return its value. Throws the page's own error if it throws. */
  page.evaluate = (fn, ...args) => page.evaluateWith(fn, args, false);

  /**
   * The same, but as a REAL user gesture (`userGesture: true`), which is what the platform
   * requires before a page may ask for a picked directory's permission. Using this where a
   * gesture is not required would hide the very bug the checks are looking for, so it is opt-in.
   */
  page.evaluateWithGesture = (fn, ...args) => page.evaluateWith(fn, args, true);

  page.evaluateWith = async (fn, args, userGesture) => {
    const expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")})`;
    const result = await page.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (result.exceptionDetails) {
      throw new Error(
        `page threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`,
      );
    }
    return result.result.value;
  };

  /**
   * The centre of an element, AFTER scrolling it into view.
   *
   * The scroll matters: a real mouse event is dispatched at viewport coordinates, and an element
   * below the fold gets a click at coordinates where it is not — the page simply does nothing, and
   * the failure looks like a broken handler rather than a misplaced pointer. (Found exactly that
   * way: adding one panel to the page pushed the form out of the viewport.)
   */
  const rect = (selector) =>
    page.evaluate((sel) => {
      const node = document.querySelector(sel);
      if (!node) return null;
      node.scrollIntoView({ block: "center", inline: "center" });
      const box = node.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }, selector);

  /** A real mouse click at the element's centre. */
  page.click = async (selector) => {
    const at = await rect(selector);
    if (!at) throw new Error(`no element matches ${selector}`);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", {
        type,
        x: Math.round(at.x),
        y: Math.round(at.y),
        button: "left",
        clickCount: 1,
      });
    }
    await sleep(120);
  };

  /**
   * Real keyboard input: focus the field by clicking it, select what is there, then insert text.
   * The select-all matters — a field with a default value would otherwise silently concatenate,
   * and a test that types "check1.svg" into "atlas.svg" and then looks for "check1.svg" fails for
   * a reason that has nothing to do with the code under test.
   */
  page.type = async (selector, text) => {
    await page.click(selector);
    for (const type of ["keyDown", "keyUp"]) {
      await page.send("Input.dispatchKeyEvent", {
        type,
        modifiers: 2, // Ctrl
        key: "a",
        code: "KeyA",
        windowsVirtualKeyCode: 65,
      });
    }
    await page.send("Input.insertText", { text });
    await sleep(80);
  };

  /**
   * Poll the page until `fn` returns something truthy.
   *
   * `args` exists because the function is stringified and run in the page: a closure over the
   * test's own variables is not there when it arrives, and the failure it produces is a timeout
   * with no error in it — the worst kind of test bug.
   */
  page.waitFor = async (fn, { timeout = 15000, label = "condition", args = [] } = {}) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await page.evaluate(fn, ...args);
      if (last) return last;
      await sleep(120);
    }
    throw new Error(`timed out waiting for ${label}; last value ${JSON.stringify(last)}`);
  };

  return page;
}
