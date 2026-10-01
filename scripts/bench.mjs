#!/usr/bin/env node
// Measures what a turn actually costs, against a real consuming repo.
//
//   node scripts/bench.mjs <path-to-consuming-repo> [options]
//
//     --packages <n>   spread the edited fixtures over n packages (default 1)
//     --runs <n>       timed runs after the warm-up (default 4)
//     --baseline <ref> also time format.mjs from a git ref and compare
//
// Reports the first run separately from the rest on purpose. A cold run pays
// for disk caches and tsgolint's first program build that later runs do not,
// and pnpm install resets them. Quoting a cold number as "the" cost, or a warm
// one while ignoring that every install pays the cold price again, both
// mislead.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FIXTURE_DIR = ".agent-hooks-bench";
const UNFORMATTED_TS =
  "export const v = {b:1,a:2}\nexport function f(x:number){   return x+1 }\n";

function parseArguments(argv) {
  const options = { baseline: undefined, packages: 1, runs: 4 };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--packages" || argument === "--runs") {
      options[argument.slice(2)] = Number(argv[index + 1]);
      index += 1;
    } else if (argument === "--baseline") {
      options.baseline = argv[index + 1];
      index += 1;
    } else {
      positional.push(argument);
    }
  }
  return { ...options, repoRoot: positional[0] && path.resolve(positional[0]) };
}

function run(command, commandArguments, { cwd, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArguments, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.on("error", reject);
    child.on("close", () => resolve(stdout));
    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

// Each package directory is a separate TypeScript project for the type-aware
// pass. Spreading fixtures across them is what exercises a turn that touched
// several packages.
function findPackageDirectories(repoRoot) {
  const found = [];
  const walk = (directory, depth) => {
    if (depth > 2) {
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    const hasConfig = entries.some(
      (entry) => entry.isFile() && entry.name === "tsconfig.json",
    );
    if (hasConfig && directory !== repoRoot) {
      found.push(directory);
    }
    for (const entry of entries) {
      if (
        entry.isDirectory() &&
        entry.name !== "node_modules" &&
        !entry.name.startsWith(".")
      ) {
        walk(path.join(directory, entry.name), depth + 1);
      }
    }
  };
  walk(repoRoot, 0);
  return found.sort();
}

function ledgerFile(sessionId) {
  return path.join(os.tmpdir(), "instrument-agent-hooks", `${sessionId}.txt`);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function timeStop({ files, hook, repoRoot, sessionId }) {
  for (const file of files) {
    fs.writeFileSync(file, UNFORMATTED_TS);
  }
  fs.mkdirSync(path.dirname(ledgerFile(sessionId)), { recursive: true });
  fs.writeFileSync(ledgerFile(sessionId), `${files.join("\n")}\n`);

  const started = process.hrtime.bigint();
  await run("node", [hook], {
    cwd: repoRoot,
    input: JSON.stringify({
      hook_event_name: "Stop",
      session_id: sessionId,
      stop_hook_active: false,
    }),
  });
  return Number(process.hrtime.bigint() - started) / 1e6;
}

async function measure({ files, hook, label, repoRoot, runs }) {
  const timings = [];
  for (let index = 0; index <= runs; index += 1) {
    timings.push(
      await timeStop({
        files,
        hook,
        repoRoot,
        sessionId: `bench-${label}-${index}-${process.pid}`,
      }),
    );
  }
  const [cold, ...warm] = timings;
  return { cold, warm: median(warm), warmAll: warm };
}

async function main() {
  const { baseline, packages, repoRoot, runs } = parseArguments(
    process.argv.slice(2),
  );
  if (!repoRoot) {
    console.error("usage: node scripts/bench.mjs <path-to-consuming-repo>");
    process.exit(2);
  }

  const hook = path.resolve(import.meta.dirname, "../format.mjs");
  const packageDirectories = findPackageDirectories(repoRoot);
  if (packageDirectories.length === 0) {
    console.error(
      `no packages with a tsconfig.json found under ${repoRoot}`,
    );
    process.exit(2);
  }

  const targets = packageDirectories.slice(0, Math.max(1, packages));
  const fixtureDirectories = targets.map((directory) =>
    path.join(directory, FIXTURE_DIR),
  );
  const files = fixtureDirectories.map((directory) =>
    path.join(directory, "bench.ts"),
  );

  let baselineHook;
  try {
    for (const directory of fixtureDirectories) {
      fs.mkdirSync(directory, { recursive: true });
    }

    console.log(`repo:     ${repoRoot}`);
    console.log(
      `packages: ${targets.length} (${targets.map((directory) => path.relative(repoRoot, directory)).join(", ")})`,
    );
    console.log(`runs:     1 cold + ${runs} warm\n`);

    const current = await measure({
      files,
      hook,
      label: "current",
      repoRoot,
      runs,
    });
    console.log(
      `current    cold ${current.cold.toFixed(0)}ms   warm ${current.warm.toFixed(0)}ms   [${current.warmAll.map((value) => value.toFixed(0)).join(", ")}]`,
    );

    if (baseline) {
      const source = await run("git", ["show", `${baseline}:format.mjs`], {
        cwd: path.resolve(import.meta.dirname, ".."),
      });
      if (!source.trim()) {
        console.error(`\ncould not read format.mjs from ${baseline}`);
        process.exit(2);
      }
      baselineHook = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "agent-hooks-bench-")),
        "format.mjs",
      );
      fs.writeFileSync(baselineHook, source);

      const previous = await measure({
        files,
        hook: baselineHook,
        label: "baseline",
        repoRoot,
        runs,
      });
      console.log(
        `${baseline.padEnd(10)} cold ${previous.cold.toFixed(0)}ms   warm ${previous.warm.toFixed(0)}ms   [${previous.warmAll.map((value) => value.toFixed(0)).join(", ")}]`,
      );
      console.log(
        `\nwarm speedup: ${(previous.warm / current.warm).toFixed(2)}x`,
      );
    }
  } finally {
    for (const directory of fixtureDirectories) {
      fs.rmSync(directory, { force: true, recursive: true });
    }
    if (baselineHook) {
      fs.rmSync(path.dirname(baselineHook), { force: true, recursive: true });
    }
    try {
      const ledgerDirectory = path.join(os.tmpdir(), "instrument-agent-hooks");
      for (const name of fs.readdirSync(ledgerDirectory)) {
        if (name.startsWith("bench-")) {
          fs.rmSync(path.join(ledgerDirectory, name), { force: true });
        }
      }
    } catch {
      // Nothing to clean.
    }
  }
}

await main();
