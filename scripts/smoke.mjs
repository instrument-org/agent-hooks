#!/usr/bin/env node
// Drives format.mjs with synthetic hook payloads against a real consuming repo
// and asserts the behaviours that are easy to break and invisible until they
// bite: what gets formatted when, what is deliberately left alone, and whether
// the Stop report still blocks.
//
//   node scripts/smoke.mjs <path-to-consuming-repo> [--hook <format.mjs>]
//
// Fixtures live in a temp directory inside the target repo and are removed on
// exit, including on failure. Nothing outside that directory is touched, which
// matters because a consuming repo usually has real work in progress.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FIXTURE_DIR = ".agent-hooks-smoke";
const HOOK_TIMEOUT_MS = 120_000;

const UNFORMATTED_TS = "export const v = {b:1,a:2}\n";
const RAW_MARKDOWN = "# Title\n\n\n\nSome   text   \n";
const MISSPELLED_MARKDOWN = "A colour that is travelling.\n";

function parseArguments(argv) {
  const positional = [];
  let hook;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--hook") {
      hook = argv[index + 1];
      index += 1;
    } else {
      positional.push(argv[index]);
    }
  }
  return {
    hook: hook
      ? path.resolve(hook)
      : path.resolve(import.meta.dirname, "../format.mjs"),
    repoRoot: positional[0] ? path.resolve(positional[0]) : undefined,
  };
}

// The hook reads stdin to completion before doing anything, so the payload must
// be written AND the stream closed. Node's async execFile has no `input`
// option: passing one is silently ignored, the hook then waits forever, and the
// run hangs with no output. Drive stdin explicitly and time out loudly.
function runHook({ cwd, hook, payload }) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [hook], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `hook timed out after ${HOOK_TIMEOUT_MS}ms (stdin left open?)\n${stderr}`,
        ),
      );
    }, HOOK_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(stdout);
    });

    child.stdin.write(
      typeof payload === "string" ? payload : JSON.stringify(payload),
    );
    child.stdin.end();
  });
}

function ledgerFile(sessionId) {
  return path.join(os.tmpdir(), "instrument-agent-hooks", `${sessionId}.txt`);
}

function seedLedger(sessionId, absolutePaths) {
  const file = ledgerFile(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${absolutePaths.join("\n")}\n`);
}

function clearLedger(sessionId) {
  for (const suffix of ["", ".pending"]) {
    try {
      fs.unlinkSync(`${ledgerFile(sessionId)}${suffix}`);
    } catch {
      // Already gone.
    }
  }
}

const results = [];

function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok) });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok && detail) {
    console.log(`        ${detail}`);
  }
}

async function main() {
  const { hook, repoRoot } = parseArguments(process.argv.slice(2));

  if (!repoRoot) {
    console.error("usage: node scripts/smoke.mjs <path-to-consuming-repo>");
    process.exit(2);
  }
  if (!fs.existsSync(path.join(repoRoot, "node_modules/.bin/oxfmt"))) {
    console.error(
      `${repoRoot} has no node_modules/.bin/oxfmt -- run pnpm install there first`,
    );
    process.exit(2);
  }

  const fixtureRoot = path.join(repoRoot, FIXTURE_DIR);
  const sessions = new Set();
  const session = (name) => {
    const id = `smoke-${name}-${process.pid}`;
    sessions.add(id);
    return id;
  };
  const fixture = (name, contents) => {
    const file = path.join(fixtureRoot, name);
    fs.writeFileSync(file, contents);
    return file;
  };
  const read = (file) => fs.readFileSync(file, "utf8");

  fs.rmSync(fixtureRoot, { force: true, recursive: true });
  fs.mkdirSync(fixtureRoot, { recursive: true });

  try {
    console.log(`hook: ${hook}`);
    console.log(`repo: ${repoRoot}\n`);

    console.log("PostToolUse");
    const editSession = session("edit");
    const codeFile = fixture("code.ts", UNFORMATTED_TS);
    await runHook({
      cwd: repoRoot,
      hook,
      payload: {
        hook_event_name: "PostToolUse",
        session_id: editSession,
        tool_input: { file_path: codeFile },
        tool_name: "Edit",
      },
    });
    check(
      "code is oxfmt-formatted on edit",
      read(codeFile).includes("{ b: 1, a: 2 }"),
      `got: ${read(codeFile).trim()}`,
    );
    check(
      "lint fixes are NOT applied on edit (deferred to Stop)",
      !read(codeFile).includes("{ a: 2, b: 1 }"),
      `got: ${read(codeFile).trim()}`,
    );

    const docFile = fixture("doc.md", RAW_MARKDOWN);
    await runHook({
      cwd: repoRoot,
      hook,
      payload: {
        hook_event_name: "PostToolUse",
        session_id: editSession,
        tool_input: { file_path: docFile },
        tool_name: "Edit",
      },
    });
    check(
      "prose is left alone on edit",
      read(docFile) === RAW_MARKDOWN,
      "markdown was reformatted mid-turn",
    );

    console.log("\nStop");
    seedLedger(editSession, [codeFile, docFile]);
    await runHook({
      cwd: repoRoot,
      hook,
      payload: {
        hook_event_name: "Stop",
        session_id: editSession,
        stop_hook_active: false,
      },
    });
    check(
      "lint fixes applied at Stop",
      read(codeFile).includes("{ a: 2, b: 1 }"),
      `got: ${read(codeFile).trim()}`,
    );
    check(
      "prose formatted at Stop",
      read(docFile) !== RAW_MARKDOWN,
      "markdown never got formatted",
    );

    console.log("\nSpelling");
    const spellSession = session("spell");
    const proseFile = fixture("prose.md", MISSPELLED_MARKDOWN);
    seedLedger(spellSession, [proseFile]);
    await runHook({
      cwd: repoRoot,
      hook,
      payload: {
        hook_event_name: "Stop",
        session_id: spellSession,
        stop_hook_active: false,
      },
    });
    check(
      "misspellings are corrected at Stop",
      read(proseFile).includes("color") && read(proseFile).includes("traveling"),
      `got: ${read(proseFile).trim()}`,
    );

    // Asserted against the source rather than by behavior, which is a weaker
    // test than the rest of this file and deliberately so. typos honors
    // extend-exclude for an explicitly-passed path only under --force-exclude,
    // and only for the slash-anchored patterns; a bare filename is honored
    // either way. Every slash-anchored exclude in a consuming repo names a real
    // tracked file, so a behavioral version of this check would have to hand
    // the hook one of them -- and would corrupt it in the exact case it exists
    // to catch. The flag's effect is verified by hand against those paths; what
    // is worth guarding here is that nobody quietly drops it.
    check(
      "the spelling pass passes --force-exclude",
      fs.readFileSync(hook, "utf8").includes('"--force-exclude"'),
      "typos would rewrite files whose misspellings are the content",
    );

    // The guarantee that matters most: a turn must never rewrite files it did
    // not edit, because a parallel agent may be mid-edit in the same checkout.
    console.log("\nScoping");
    const scopeSession = session("scope");
    const mine = fixture("mine.ts", UNFORMATTED_TS);
    const theirs = fixture("theirs.ts", UNFORMATTED_TS);
    seedLedger(scopeSession, [mine]);
    await runHook({
      cwd: repoRoot,
      hook,
      payload: {
        hook_event_name: "Stop",
        session_id: scopeSession,
        stop_hook_active: false,
      },
    });
    check("files in the ledger are formatted", read(mine) !== UNFORMATTED_TS);
    check(
      "files NOT in the ledger are untouched",
      read(theirs) === UNFORMATTED_TS,
      "a parallel agent's dirty file was rewritten",
    );

    const rotated = await runHook({
      cwd: repoRoot,
      hook,
      payload: {
        hook_event_name: "Stop",
        session_id: scopeSession,
        stop_hook_active: false,
      },
    });
    check(
      "a second Stop with no new edits is a no-op",
      rotated.trim() === "{}" && read(theirs) === UNFORMATTED_TS,
      `got: ${rotated.trim()}`,
    );

    console.log("\nReport");
    const blockSession = session("block");
    // no-console and no-debugger are enforced and have no fixer, so --fix
    // leaves them behind. Do not reach for no-explicit-any or no-unused-vars
    // here: the type-aware rules moved to oxlint and ESLint no longer reports
    // them, which reads as "blocking is broken" when it is the fixture at fault.
    const badFile = fixture(
      "bad.ts",
      'export function f() {\n  console.log("x");\n  debugger;\n}\n',
    );
    seedLedger(blockSession, [badFile]);
    const blocked = await runHook({
      cwd: repoRoot,
      hook,
      payload: {
        hook_event_name: "Stop",
        session_id: blockSession,
        stop_hook_active: false,
      },
    });
    let blockJson = {};
    try {
      blockJson = JSON.parse(blocked || "{}");
    } catch {
      // Left empty; the check below prints the raw output.
    }
    check(
      "unfixable lint blocks Stop",
      blockJson.decision === "block" && typeof blockJson.reason === "string",
      `got: ${blocked.trim().slice(0, 300)}`,
    );

    seedLedger(blockSession, [badFile]);
    const noLoop = await runHook({
      cwd: repoRoot,
      hook,
      payload: {
        hook_event_name: "Stop",
        session_id: blockSession,
        stop_hook_active: true,
      },
    });
    check(
      "stop_hook_active suppresses the block (no loop)",
      noLoop.trim() === "{}",
      `got: ${noLoop.trim().slice(0, 200)}`,
    );

    console.log("\nEdge cases");
    const noLedger = await runHook({
      cwd: repoRoot,
      hook,
      payload: {
        hook_event_name: "Stop",
        session_id: `smoke-absent-${process.pid}`,
        stop_hook_active: false,
      },
    });
    check("Stop with no ledger is a no-op", noLedger.trim() === "{}");

    const garbage = await runHook({ cwd: repoRoot, hook, payload: "not json" });
    check("malformed stdin is survivable", garbage.trim() === "{}");

    const outside = await runHook({
      cwd: os.tmpdir(),
      hook,
      payload: { hook_event_name: "Stop", session_id: "smoke-outside" },
    });
    check("non-Instrument repo is a no-op", outside.trim() === "{}");
  } finally {
    fs.rmSync(fixtureRoot, { force: true, recursive: true });
    for (const id of sessions) {
      clearLedger(id);
    }
  }

  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
