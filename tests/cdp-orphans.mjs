// tests/cdp-orphans.mjs — close() must take Chrome's helper processes with it.
//
// Launching a browser and signalling only the browser process leaves renderer, GPU, zygote and
// crashpad helpers reparented and running: one crashpad handler outlived its browser by 46 minutes
// on this 2-vCPU VM, holding memory until the reaper noticed it (idb-vector-6i3).
//
// This checks the MECHANISM, not a command-line pattern: every process in the browser's process
// group must be gone after close(). A helper keeps its group id when it is reparented, so a group
// id that is still populated after close() is exactly the orphan condition, whatever the helper is
// called or renamed to. It also asserts the group was populated BEFORE close(), because a test that
// passes on an empty group proves nothing.
import { readFileSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { launch } from "./lib/cdp.mjs";

let passed = 0;
function check(condition, label) {
  if (condition) {
    passed += 1;
    return;
  }
  throw new Error(`FAIL: ${label}`);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// /proc/<pid>/stat: "pid (comm) state ppid pgrp ..." — comm can contain spaces and parentheses, so
// the fields are read from after the LAST ')' rather than by splitting the whole line.
function processGroupOf(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(rest[2]);
}

function groupMembers(pgid) {
  const members = [];
  for (const entry of readdirSync("/proc")) {
    if (/^\d+$/.test(entry) === false) continue;
    try {
      if (processGroupOf(Number(entry)) === pgid) members.push(Number(entry));
    } catch {
      // The process exited between readdir and read, or is not ours to inspect.
    }
  }
  return members.sort((a, b) => a - b);
}

if (process.platform !== "linux" || readdirSync("/proc").length === 0) {
  // Not a silent pass: say why nothing was verified.
  console.log("SKIP: cdp-orphans needs Linux /proc to read process groups");
  process.exit(0);
}

const page = await launch();
const pgid = page.pid;
try {
  check(Number.isInteger(pgid) && pgid > 0, `browser reports a pid (${pgid})`);
  const before = groupMembers(pgid);
  check(groupMembers(pgid).includes(pgid), "the browser is the leader of its own process group");
  check(
    before.length >= 2,
    `the browser had helpers to orphan before close (group ${pgid} had ${before.length} member(s): ${before.join(", ")})`,
  );
  console.log(`  group ${pgid} before close: ${before.length} processes`);

  await page.close();

  // Sampled rather than polled once: a helper that survives its browser is visible immediately, and
  // one that happens to die later must not be able to hide behind a single lucky sample.
  const samples = [];
  for (const waitMs of [0, 250, 750]) {
    if (waitMs > 0) await sleep(waitMs);
    samples.push({ atMs: waitMs, members: groupMembers(pgid) });
  }

  check(samples[0].members.length === 0, `no helper survived close() (found ${samples[0].members.join(", ")})`);
  check(samples[1].members.length === 0, `no helper survived close() + 250 ms (found ${samples[1].members.join(", ")})`);
  check(samples[2].members.length === 0, `no helper survived close() + 1 s (found ${samples[2].members.join(", ")})`);
  check(!alive(pgid), "the browser process itself is gone");

  console.log(`  after close: 0 processes in group ${pgid} (sampled at 0, 250 and 1000 ms)`);

  // --- a suite that exits WITHOUT closing =====================================================
  // The browser leads its own process group, so it no longer goes down with the suite's group. A
  // separate process launches a browser, reports its pid and exits without closing: if the group is
  // still populated afterwards, every suite that throws or calls process.exit() leaks a browser.
  const cdpLib = new URL("./lib/cdp.mjs", import.meta.url).href;
  const script = `
    const { launch } = await import(${JSON.stringify(cdpLib)});
    const page = await launch();
    console.log(JSON.stringify({ pid: page.pid }));
    process.exit(3);
  `;
  const suite = spawn(process.execPath, ["--input-type=module", "-e", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  suite.stdout.on("data", (chunk) => { stdout += chunk; });
  suite.stderr.on("data", (chunk) => { stderr += chunk; });
  const suiteCode = await new Promise((resolve) => suite.once("exit", (code) => resolve(code)));
  check(suiteCode === 3, `the unclosed-browser suite exited with its own code (got ${suiteCode}; stderr: ${stderr.slice(-200)})`);

  const reported = stdout.split("\n").filter((line) => line.trim().startsWith("{"));
  check(reported.length === 1, `the suite reported exactly one browser pid (got ${reported.length}: ${stdout.trim().slice(-200)})`);
  const unclosedPid = JSON.parse(reported[0]).pid;

  // Bounded poll: the exit handler signals synchronously, and reaping is the kernel's, so this is
  // normally immediate and never more than a moment. A survivor here is the orphan itself.
  let leftovers = groupMembers(unclosedPid);
  const deadline = Date.now() + 4000;
  while (leftovers.length > 0 && Date.now() < deadline) {
    await sleep(100);
    leftovers = groupMembers(unclosedPid);
  }
  check(
    leftovers.length === 0,
    `no browser survived a suite that exited without close() (group ${unclosedPid} still had: ${leftovers.join(", ")})`,
  );
  console.log(`  suite exited without close(): 0 processes left in group ${unclosedPid}`);

  console.log(`PASS: ${passed} cdp-orphan checks`);
} finally {
  // Idempotent: if an assertion failed above, this still takes the group down.
  await page.close();
}
