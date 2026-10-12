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

// The spread is unicorn/no-useless-spread, an oxlint autofix that formatting
// alone never applies.
const UNFORMATTED_TS = "export const v = [...[1,2]]\n";
const RAW_MARKDOWN = "# Title\n\n\n\nSome   text   \n";
const MISSPELLED_MARKDOWN = "We recieve teh result.\n";

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
      read(codeFile).includes("[...[1, 2]]"),
      `got: ${read(codeFile).trim()}`,
    );
    check(
      "lint fixes are NOT applied on edit (deferred to Stop)",
      read(codeFile).includes("..."),
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
      read(codeFile).includes("v = [1, 2]"),
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
    // Plain transpositions rather than British spellings, so this holds in any
    // consuming repo: locale corrections are allowlistable per repo and one of
    // them allows `colour` outright, for a library that spells its options that
    // way.
    check(
      "misspellings are corrected at Stop",
      read(proseFile) === "We receive the result.\n",
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

    // A worktree nested in the checkout (`.claude/worktrees/<name>`) is a
    // checkout of its own, with a root config that may set options only a root
    // config may. A session that edited it and then left it ends its turn in
    // the outer checkout, which must not lint the worktree's files as its own.
    console.log("\nNested worktree");
    const worktreeSession = session("worktree");
    const worktreeRoot = path.join(fixtureRoot, "worktree");
    fs.mkdirSync(worktreeRoot);
    fs.writeFileSync(
      path.join(worktreeRoot, ".git"),
      `gitdir: ${path.join(worktreeRoot, ".gitdir")}\n`,
    );
    fs.copyFileSync(
      path.join(repoRoot, "package.json"),
      path.join(worktreeRoot, "package.json"),
    );
    fs.writeFileSync(
      path.join(worktreeRoot, ".oxlintrc.json"),
      `${JSON.stringify({
        categories: { correctness: "error" },
        options: { typeAware: true },
      })}\n`,
    );
    fs.symlinkSync(
      path.join(repoRoot, "node_modules"),
      path.join(worktreeRoot, "node_modules"),
    );
    const worktreeFile = path.join(worktreeRoot, "code.ts");
    fs.writeFileSync(worktreeFile, UNFORMATTED_TS);
    seedLedger(worktreeSession, [worktreeFile]);
    const fromOutside = await runHook({
      cwd: repoRoot,
      hook,
      payload: {
        hook_event_name: "Stop",
        session_id: worktreeSession,
        stop_hook_active: false,
      },
    });
    // knip may still answer: the fixture checkout has no knip config, so to it
    // every file and dependency is unused. Only oxlint's answer is in question.
    check(
      "a worktree's edits are linted from the worktree, not the outer checkout",
      !fromOutside.includes("oxlint reported") &&
        read(worktreeFile).includes("v = [1, 2]"),
      `got: ${fromOutside.trim().slice(0, 300)} / ${read(worktreeFile).trim()}`,
    );

    console.log("\nReport");
    const blockSession = session("block");
    // A duplicate key is in oxlint's correctness category and has no fixer, so
    // --fix leaves it behind. Avoid a type-aware rule here: the fixture sits
    // outside every tsconfig project, so type information may not reach it,
    // which reads as "blocking is broken" when it is the fixture at fault.
    const badFile = fixture("bad.ts", "export const o = { a: 1, a: 2 };\n");
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

    // The fixture directory is outside every knip entry, so any .ts file in it
    // is an unused file to knip: a finding in the ledger, and one beside it.
    console.log("\nUnused");
    const unusedSession = session("unused");
    const myOrphan = fixture("my-orphan.ts", "export const mine = 1;\n");
    fixture("their-orphan.ts", "export const theirs = 1;\n");
    seedLedger(unusedSession, [myOrphan]);
    const unused = await runHook({
      cwd: repoRoot,
      hook,
      payload: {
        hook_event_name: "Stop",
        session_id: unusedSession,
        stop_hook_active: false,
      },
    });
    check(
      "knip findings in an edited file block Stop",
      unused.includes("knip") && unused.includes("my-orphan.ts"),
      `got: ${unused.trim().slice(0, 300)}`,
    );
    check(
      "knip findings in a file the turn did not edit are not reported",
      !unused.includes("their-orphan.ts"),
      `got: ${unused.trim().slice(0, 300)}`,
    );

    const proseSession = session("unused-prose");
    seedLedger(proseSession, [fixture("notes.md", "# Notes\n")]);
    const proseOnly = await runHook({
      cwd: repoRoot,
      hook,
      payload: {
        hook_event_name: "Stop",
        session_id: proseSession,
        stop_hook_active: false,
      },
    });
    check(
      "a prose-only turn skips knip",
      proseOnly.trim() === "{}",
      `got: ${proseOnly.trim().slice(0, 300)}`,
    );

    // A package of its own, so the edit has a manifest with a vitest config
    // beside it. Its vitest forwards to the repo's, since installing one into
    // the fixture would take longer than the rest of the suite.
    console.log("\nRelated tests");
    const testPackage = path.join(fixtureRoot, "tested");
    fs.mkdirSync(path.join(testPackage, "node_modules/.bin"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(testPackage, "package.json"),
      '{ "name": "smoke-tested", "type": "module" }\n',
    );
    fs.writeFileSync(
      path.join(testPackage, "vitest.config.mjs"),
      "export default {};\n",
    );
    const vitestShim = path.join(testPackage, "node_modules/.bin/vitest");
    fs.writeFileSync(
      vitestShim,
      `#!/bin/sh\nexec "${path.join(repoRoot, "node_modules/.bin/vitest")}" "$@"\n`,
    );
    fs.chmodSync(vitestShim, 0o755);
    const tested = (name, contents) => {
      const file = path.join(testPackage, name);
      fs.writeFileSync(file, contents);
      return file;
    };
    const vitestImport = `import { expect, it } from "${path.join(repoRoot, "node_modules/vitest/dist/index.js")}";\n`;
    const brokenSource = tested("broken.mjs", "export const answer = 41;\n");
    tested(
      "broken.test.mjs",
      `${vitestImport}import { answer } from "./broken.mjs";\nit("adds up", () => { expect(answer).toBe(42); });\n`,
    );
    const sound = tested("sound.mjs", "export const answer = 42;\n");
    tested(
      "sound.test.mjs",
      `${vitestImport}import { answer } from "./sound.mjs";\nit("holds", () => { expect(answer).toBe(42); });\n`,
    );

    // Fails whenever it runs, so it reports only if an unrelated test ran.
    tested(
      "unrelated.test.mjs",
      `${vitestImport}it("is never run", () => { expect(1).toBe(2); });\n`,
    );

    const failingSession = session("tests-failing");
    seedLedger(failingSession, [brokenSource]);
    const failing = await runHook({
      cwd: repoRoot,
      hook,
      payload: {
        hook_event_name: "Stop",
        session_id: failingSession,
        stop_hook_active: false,
      },
    });
    check(
      "a failing test that imports an edit blocks Stop",
      failing.includes("Tests that import") && failing.includes("adds up"),
      `got: ${failing.trim().slice(0, 300)}`,
    );
    check(
      "tests that do not import the edit are not run",
      !failing.includes("is never run"),
      `got: ${failing.trim().slice(0, 300)}`,
    );

    const passingSession = session("tests-passing");
    seedLedger(passingSession, [sound]);
    const passing = await runHook({
      cwd: repoRoot,
      hook,
      payload: {
        hook_event_name: "Stop",
        session_id: passingSession,
        stop_hook_active: false,
      },
    });
    check(
      "passing related tests leave nothing to report",
      !passing.includes("Tests that import"),
      `got: ${passing.trim().slice(0, 300)}`,
    );

    console.log("\nShell edits");
    const shellSession = session("shell");
    const untouched = fixture("untouched.ts", UNFORMATTED_TS);
    const shellPayload = (event) => ({
      cwd: repoRoot,
      hook_event_name: event,
      session_id: shellSession,
      tool_input: { command: "cat > shell.ts" },
      tool_name: "Bash",
      tool_use_id: "toolu_smoke",
    });
    await runHook({ cwd: repoRoot, hook, payload: shellPayload("PreToolUse") });
    // What a heredoc or sed -i does: a write no Edit or Write event names.
    const shellFile = fixture("shell.ts", UNFORMATTED_TS);
    await runHook({ cwd: repoRoot, hook, payload: shellPayload("PostToolUse") });
    check(
      "a file a shell command wrote is formatted",
      read(shellFile).includes("[...[1, 2]]"),
      `got: ${read(shellFile).trim()}`,
    );
    const shellLedger = fs.existsSync(ledgerFile(shellSession))
      ? read(ledgerFile(shellSession))
      : "";
    check(
      "a file a shell command wrote joins the ledger",
      shellLedger.includes(shellFile),
      `ledger: ${shellLedger.trim()}`,
    );
    check(
      "a dirty file the command left alone does not",
      !shellLedger.includes(untouched) && read(untouched) === UNFORMATTED_TS,
      `ledger: ${shellLedger.trim()}`,
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
