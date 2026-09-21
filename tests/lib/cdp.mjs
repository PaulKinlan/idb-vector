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
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("chromium did not print a DevTools endpoint")), 20000);
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
    child.on("exit", (code) => reject(new Error(`chromium exited early (${code})`)));
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

  const page = {
    sessionId,
    send: (method, params) => send(method, params, sessionId),
    async close() {
      try {
        socket.close();
      } catch {}
      try {
        child.kill("SIGKILL");
      } catch {}
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
