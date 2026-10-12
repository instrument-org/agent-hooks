import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const OXFMT_EXT =
  /\.(?:ts|tsx|mjs|cjs|js|jsx|json|jsonc|css|md|mdx|yaml|yml|html)$/i;
const LINT_EXT = /\.(?:ts|tsx|mjs|cjs|js|jsx)$/i;

// Formatted the moment they are written. Prose and stylesheets are deliberately
// absent and wait for Stop: a turn often makes several edits to one document
// against remembered content, and reformatting between them invalidates the
// text the next edit is anchored to. Code earns the immediate pass because the
// lint fixes at Stop build on already-formatted input.
const IMMEDIATE_FORMAT_EXT =
  /\.(?:ts|tsx|mjs|cjs|js|jsx|json|jsonc|yaml|yml|html)$/i;

const INSTRUMENT_ROOT_NAMES = new Set([
  "@instrument-org/monorepo",
  "@instrument-org/skills",
  "@instrument/internal",
]);

const MAX_BUFFER = 50 * 1024 * 1024;
// Keep argv well under ARG_MAX when a turn touches a lot of files.
const BATCH_SIZE = 40;

// -------------------------------------------------------------------------
// Process pool
//
// Every pass below costs one tool spawn, and spawn overhead (not linting) is
// what the hook actually spends its time on. Batches are therefore dispatched
// concurrently; this pool is the single place that
// bounds how many run at once, so callers can use Promise.all freely.
// -------------------------------------------------------------------------

const MAX_CONCURRENT_PROCESSES = Math.max(
  2,
  Math.min(8, os.availableParallelism?.() ?? 4),
);
let activeProcesses = 0;
const waitingForSlot = [];

async function withProcessSlot(run) {
  if (activeProcesses >= MAX_CONCURRENT_PROCESSES) {
    await new Promise((resolve) => waitingForSlot.push(resolve));
  }
  activeProcesses += 1;
  try {
    return await run();
  } finally {
    activeProcesses -= 1;
    waitingForSlot.shift()?.();
  }
}

// Tools signal findings with a non-zero exit, so a failure is expected rather
// than exceptional: return the captured stdout instead of throwing.
async function execTool(file, arguments_, options) {
  return withProcessSlot(async () => {
    try {
      const { stdout } = await execFileAsync(file, arguments_, {
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        ...options,
      });
      return { ok: true, stdout: stdout ?? "" };
    } catch (error) {
      return {
        ok: false,
        stdout: typeof error.stdout === "string" ? error.stdout : "",
      };
    }
  });
}

async function runBatched(repoRoot, files, run) {
  if (files.length === 0) {
    return "";
  }
  const batches = [];
  for (let index = 0; index < files.length; index += BATCH_SIZE) {
    batches.push(files.slice(index, index + BATCH_SIZE));
  }
  const outputs = await Promise.all(
    batches.map((batch) => run(repoRoot, batch)),
  );
  return outputs.filter((output) => typeof output === "string").join("");
}

// -------------------------------------------------------------------------
// Paths and repo detection
// -------------------------------------------------------------------------

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function shouldSkipRelative(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  return (
    normalized.startsWith("registry/") ||
    normalized.startsWith("node_modules/") ||
    normalized.includes("/node_modules/")
  );
}

function getSafeRelativePath({ filePath, repoRoot }) {
  const relativePath = path.relative(repoRoot, filePath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return;
  }
  if (shouldSkipRelative(relativePath)) {
    return;
  }
  return relativePath;
}

const checkoutRootCache = new Map();

// The checkout a file belongs to: the nearest directory holding a `.git`
// entry, which is a directory in a main checkout and a file in a linked
// worktree or a submodule. A worktree nested inside another checkout (the
// usual `.claude/worktrees/<name>`) is its own root, so its files are
// formatted and linted with its own tools and its own root config. Taken from
// the session's working directory instead, oxlint run from the outer checkout
// reads the worktree's root `.oxlintrc.json` as a nested config and refuses
// the options only a root config may set.
function getCheckoutRoot(filePath) {
  const visited = [];
  let directory = path.dirname(filePath);
  let root;
  for (;;) {
    const cached = checkoutRootCache.get(directory);
    if (cached !== undefined) {
      root = cached;
      break;
    }
    visited.push(directory);
    if (fs.existsSync(path.join(directory, ".git"))) {
      root = directory;
      break;
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      root = null;
      break;
    }
    directory = parent;
  }
  for (const entry of visited) {
    checkoutRootCache.set(entry, root);
  }
  return root ?? undefined;
}

// Group session-edit absolute paths by the checkout each belongs to, as paths
// relative to it, dropping anything outside an Instrument checkout or since
// deleted.
function groupByCheckout(paths) {
  const groups = new Map();
  for (const filePath of paths) {
    const repoRoot = getCheckoutRoot(filePath);
    if (!repoRoot || !isInstrumentRepoRoot(repoRoot)) {
      continue;
    }
    const relativePath = getSafeRelativePath({ filePath, repoRoot });
    if (!relativePath || !fileExists(filePath)) {
      continue;
    }
    const group = groups.get(repoRoot) ?? new Set();
    group.add(relativePath);
    groups.set(repoRoot, group);
  }
  return [...groups].map(([repoRoot, relativePaths]) => ({
    relativePaths: [...relativePaths],
    repoRoot,
  }));
}

const instrumentRepoRootCache = new Map();

function isInstrumentRepoRoot(repoRoot) {
  const cached = instrumentRepoRootCache.get(repoRoot);
  if (cached !== undefined) {
    return cached;
  }

  let isRoot = false;
  try {
    const package_ = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );
    isRoot =
      INSTRUMENT_ROOT_NAMES.has(package_.name) &&
      fs.existsSync(path.join(repoRoot, ".git"));
  } catch {
    isRoot = false;
  }

  instrumentRepoRootCache.set(repoRoot, isRoot);
  return isRoot;
}

async function getRepoRoot(cwd) {
  const { stdout } = await execTool("git", ["rev-parse", "--show-toplevel"], {
    cwd,
  });
  return stdout.trim() || cwd;
}

function getStopRoots({ data, repoRoot }) {
  const workspaceRoots = Array.isArray(data.workspace_roots)
    ? data.workspace_roots
        .filter((root) => typeof root === "string" && root.length > 0)
        .map((root) => path.resolve(root))
    : [];
  const roots = workspaceRoots.length > 0 ? workspaceRoots : [repoRoot];
  const instrumentRoots = roots.filter((root) => isInstrumentRepoRoot(root));
  if (instrumentRoots.length === 0) {
    return [];
  }

  // Only the alphabetically-first root's session runs the sweep, so parallel
  // sessions in a multi-root workspace do not each repeat it.
  const primaryRoot = [...instrumentRoots].sort()[0];
  if (path.resolve(repoRoot) !== primaryRoot) {
    return [];
  }
  return instrumentRoots;
}

// -------------------------------------------------------------------------
// Session edit ledger
//
// Records what THIS session edited, so both the format sweep and the lint
// report act only on the agent's own work -- never on files a parallel agent
// left dirty in the same checkout. Stored outside the repo, keyed by session.
//
// Stop consumes the ledger by rotating it, so each turn end processes only the
// edits made since the previous one rather than replaying the whole session.
// -------------------------------------------------------------------------

function sessionEditsFile(sessionId) {
  return path.join(os.tmpdir(), "instrument-agent-hooks", `${sessionId}.txt`);
}

function recordSessionEdit(sessionId, absolutePath) {
  if (!sessionId || !absolutePath) {
    return;
  }
  try {
    const file = sessionEditsFile(sessionId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${absolutePath}\n`);
  } catch {
    // Best effort -- a missing record just means no scoped report this turn.
  }
}

function takeSessionEdits(sessionId) {
  if (!sessionId) {
    return [];
  }
  const active = sessionEditsFile(sessionId);
  const pending = `${active}.pending`;

  // Rotate first so edits arriving while this turn runs land in a fresh file
  // and are picked up by the next Stop instead of being dropped.
  try {
    fs.renameSync(active, pending);
  } catch {
    // Nothing new since the last Stop; a leftover .pending from an interrupted
    // run is still worth draining below.
  }

  let content = "";
  try {
    content = fs.readFileSync(pending, "utf8");
  } catch {
    return [];
  }
  try {
    fs.unlinkSync(pending);
  } catch {
    // Ignore -- a stale file is re-read harmlessly next turn.
  }

  return [
    ...new Set(
      content
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

// Delete session-edit files older than a week so /tmp does not accumulate.
function pruneSessionEdits() {
  try {
    const directory = path.join(os.tmpdir(), "instrument-agent-hooks");
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      try {
        if (now - fs.statSync(file).mtimeMs > weekMs) {
          fs.unlinkSync(file);
        }
      } catch {
        // Ignore files that vanish or cannot be stat-ed.
      }
    }
  } catch {
    // Directory may not exist yet -- nothing to prune.
  }
}

// -------------------------------------------------------------------------
// Tool runners
// -------------------------------------------------------------------------

async function runOxfmt(repoRoot, files) {
  if (files.length === 0) {
    return "";
  }
  const oxfmtPath = path.join(repoRoot, "node_modules/.bin/oxfmt");
  if (!fileExists(oxfmtPath)) {
    return "";
  }
  // oxfmt writes in place by default.
  await execTool(oxfmtPath, [...files], { cwd: repoRoot });
  return "";
}

// Fixing and reporting are one pass. Run from repoRoot, oxlint resolves each
// file's nearest .oxlintrc.json, so one spawn covers every package a turn
// touched, and what --fix leaves behind is exactly what `check:lint` would
// report. Only the reporting pass asks for type information and silences
// warnings: a type-aware run is the slow part, and a warning is advice rather
// than something to block a turn on.
async function runOxlint(repoRoot, files, { report = false } = {}) {
  if (files.length === 0) {
    return "";
  }
  const oxlintPath = path.join(repoRoot, "node_modules/.bin/oxlint");
  if (!fileExists(oxlintPath)) {
    return "";
  }
  // A config's ignores are part of what it says, and naming a file on the
  // command line is not a reason to overrule them: a repo that ignores vendored
  // or generated code means the agent editing one should hear nothing about
  // it, the same silence `check:lint` gives. Without
  // --no-error-on-unmatched-pattern, oxlint answers a batch made only of
  // ignored files with an error, which the report would hand back as work.
  const { ok, stdout } = await execTool(
    oxlintPath,
    [
      "--fix",
      "--no-error-on-unmatched-pattern",
      ...(report ? ["--type-aware", "--quiet"] : []),
      ...files,
    ],
    { cwd: repoRoot },
  );
  return report && !ok && stdout.trim() ? stdout : "";
}

// The consuming repo's scripts/typos.ts vendors a pinned, checksum-verified
// binary into node_modules/.cache and forwards arguments to it. Going back
// through that script costs ~65ms of node startup per spawn, so prefer the
// binary it already cached and keep the script as the cold path that puts it
// there. Newest directory wins: a TYPOS_VERSION bump leaves the previous
// version's directory behind, and running the stale one would spell-check
// against an outdated corrections corpus.
function findTyposBinary(repoRoot) {
  const cacheDirectory = path.join(repoRoot, "node_modules/.cache/typos");
  const binaryName = process.platform === "win32" ? "typos.exe" : "typos";
  let newest;
  let newestMtime = -1;
  let entries = [];
  try {
    entries = fs.readdirSync(cacheDirectory);
  } catch {
    return;
  }
  for (const entry of entries) {
    const candidate = path.join(cacheDirectory, entry, binaryName);
    if (!fileExists(candidate)) {
      continue;
    }
    const { mtimeMs } = fs.statSync(candidate);
    if (mtimeMs > newestMtime) {
      newest = candidate;
      newestMtime = mtimeMs;
    }
  }
  return newest;
}

async function runTypos(repoRoot, files) {
  if (files.length === 0) {
    return "";
  }
  // Repos without the runner skip the pass, like every other tool above.
  const runnerPath = path.join(repoRoot, "scripts/typos.ts");
  if (!fileExists(runnerPath)) {
    return "";
  }
  const binary = findTyposBinary(repoRoot);
  // --force-exclude is load-bearing. typos applies a slash-anchored
  // extend-exclude only while walking a directory itself, never to a path
  // handed to it, and the files excluded that way are excluded because their
  // misspellings ARE the content -- a British-English eval fixture, a document
  // quoting the spellings it is about. Without this flag a turn that edits one
  // silently corrects the thing it is demonstrating. What typos cannot correct
  // unambiguously it leaves alone, and that surfaces in the CI spelling step.
  await execTool(
    binary ?? process.execPath,
    [
      ...(binary ? [] : [runnerPath]),
      "--write-changes",
      "--force-exclude",
      ...files,
    ],
    { cwd: repoRoot },
  );
  return "";
}

// The package.json a file belongs to: the nearest one at or below repoRoot.
function owningManifest(repoRoot, relativePath) {
  let directory = path.dirname(relativePath);
  for (;;) {
    const manifest = path.join(directory, "package.json");
    if (fileExists(path.join(repoRoot, manifest))) {
      return path.normalize(manifest);
    }
    if (directory === "." || directory === "") {
      return;
    }
    directory = path.dirname(directory);
  }
}

// What knip says is unused, kept to what this turn could have caused: findings
// in a file it edited, and dependency findings in the package.json of any
// workspace it edited a file in. The second is wider than the edits on purpose,
// since a dependency goes unused when its last import is deleted somewhere else
// and is added by `pnpm add`, neither of which touches the manifest through an
// edit the ledger sees. An export left unused in a file the turn never opened
// is not reported here; CI's `check:unused` still is.
async function runKnip(repoRoot, relativePaths) {
  const knipPath = path.join(repoRoot, "node_modules/.bin/knip");
  // Prose and styles cannot leave code unused, so a turn that only touched
  // those skips the pass, and they bring no workspace's manifest into scope.
  const code = relativePaths.filter(
    (file) => LINT_EXT.test(file) || path.basename(file) === "package.json",
  );
  if (!fileExists(knipPath) || code.length === 0) {
    return "";
  }
  const edited = new Set(relativePaths.map((file) => path.normalize(file)));
  const manifests = new Set(
    code.map((file) => owningManifest(repoRoot, file)).filter(Boolean),
  );

  // knip exits 1 when it finds anything, so the exit code says nothing here
  // and only JSON that parses counts as an answer. A config error or a crash
  // prints something else and is not the agent's to fix.
  const { stdout } = await execTool(
    knipPath,
    ["--reporter", "json", "--no-progress", "--no-config-hints"],
    { cwd: repoRoot },
  );
  let rows = [];
  try {
    rows = JSON.parse(stdout).issues ?? [];
  } catch {
    return "";
  }

  const lines = [];
  for (const row of rows) {
    const file = path.normalize(row.file);
    const isManifest = path.basename(file) === "package.json";
    if (!edited.has(file) && !(isManifest && manifests.has(file))) {
      continue;
    }
    for (const [kind, issues] of Object.entries(row)) {
      if (!Array.isArray(issues) || kind === "owners") {
        continue;
      }
      for (const issue of issues.flat()) {
        const where = issue.line ? `:${issue.line}:${issue.col ?? 1}` : "";
        lines.push(
          kind === "files"
            ? `${row.file}  unused file`
            : `${row.file}${where}  ${kind}  ${issue.name}`,
        );
      }
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

// The tests that import what this turn edited, run in the package each edit
// belongs to, so a break surfaces before the work lands instead of in CI. A
// package takes part when it has its own vitest and vitest config: a root
// that only hoists the binary would crawl every test in the tree without the
// aliases each package's config sets up; the projects its `test:ci`
// names are the ones run, so a browser project kept out of CI stays out here.
// The whole pass shares one deadline, and a package that runs past it says
// nothing: a hook that stalls a turn on a slow suite costs more than CI
// catching the break. Workers are capped the way CI caps them, since other
// agents are usually working in the same checkout.
const RELATED_TESTS_DEADLINE_MS = 60_000;
const VITEST_CONFIGS = ["ts", "mts", "js", "mjs"].map(
  (extension) => `vitest.config.${extension}`,
);
const MAX_FAILURES_REPORTED = 10;

function packageTestProjects(packageDirectory) {
  try {
    const { scripts } = JSON.parse(
      fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
    );
    const testCi =
      typeof scripts?.["test:ci"] === "string" ? scripts["test:ci"] : "";
    return [...testCi.matchAll(/--project[= ](\S+)/g)].flatMap((match) => [
      "--project",
      match[1],
    ]);
  } catch {
    return [];
  }
}

function describeFailures(report, packageDirectory) {
  const lines = [];
  for (const file of report.testResults ?? []) {
    const relativeFile = path.relative(packageDirectory, file.name);
    const failed = (file.assertionResults ?? []).filter(
      (assertion) => assertion.status === "failed",
    );
    // A file that fails before any test runs (an import error, a throw at the
    // top level) has no failed assertion, only its own message.
    if (failed.length === 0 && file.status === "failed") {
      lines.push(`${relativeFile}\n  ${firstLines(file.message)}`);
    }
    for (const assertion of failed) {
      lines.push(
        `${relativeFile} > ${assertion.fullName}\n  ${firstLines(assertion.failureMessages?.[0])}`,
      );
    }
  }
  const shown = lines.slice(0, MAX_FAILURES_REPORTED);
  if (lines.length > shown.length) {
    shown.push(`… and ${lines.length - shown.length} more`);
  }
  return shown;
}

function firstLines(message = "", count = 6) {
  return message.trim().split("\n").slice(0, count).join("\n  ");
}

async function runRelatedTests(repoRoot, relativePaths) {
  const byPackage = new Map();
  for (const file of relativePaths.filter((file) => LINT_EXT.test(file))) {
    const manifest = owningManifest(repoRoot, file);
    if (!manifest) {
      continue;
    }
    const packageDirectory = path.join(repoRoot, path.dirname(manifest));
    if (
      !fileExists(path.join(packageDirectory, "node_modules/.bin/vitest")) ||
      !VITEST_CONFIGS.some((name) =>
        fileExists(path.join(packageDirectory, name)),
      )
    ) {
      continue;
    }
    const files = byPackage.get(packageDirectory) ?? [];
    files.push(path.join(repoRoot, file));
    byPackage.set(packageDirectory, files);
  }

  const deadline = Date.now() + RELATED_TESTS_DEADLINE_MS;
  const sections = [];
  // One package at a time: each run already spreads across workers, and two
  // suites at once on a shared checkout is what the worker cap is there to avoid.
  for (const [packageDirectory, files] of byPackage) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    const outputFile = path.join(
      os.tmpdir(),
      "instrument-agent-hooks",
      `vitest-${process.pid}-${sections.length}-${Date.now()}.json`,
    );
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    await execTool(
      path.join(packageDirectory, "node_modules/.bin/vitest"),
      [
        "related",
        ...files,
        "--run",
        "--passWithNoTests",
        "--maxWorkers=40%",
        ...packageTestProjects(packageDirectory),
        "--reporter=json",
        `--outputFile=${outputFile}`,
      ],
      {
        cwd: packageDirectory,
        env: { ...process.env, CI: "true" },
        timeout: remaining,
      },
    );
    // vitest exits non-zero on a failed test, so only a report that parses
    // counts. A run killed at the deadline, or one that crashed on its own
    // config, leaves none and is not the agent's to fix.
    let report;
    try {
      report = JSON.parse(fs.readFileSync(outputFile, "utf8"));
    } catch {
      continue;
    } finally {
      fs.rmSync(outputFile, { force: true });
    }
    const failures = describeFailures(report, packageDirectory);
    if (failures.length > 0) {
      sections.push(
        `${path.relative(repoRoot, packageDirectory) || "."}:\n${failures.join("\n")}`,
      );
    }
  }
  return sections.length > 0 ? `${sections.join("\n\n")}\n` : "";
}

// -------------------------------------------------------------------------
// Pipelines
// -------------------------------------------------------------------------

function snapshotMtimes(repoRoot, relativePaths) {
  const mtimes = new Map();
  for (const relativePath of relativePaths) {
    try {
      mtimes.set(
        relativePath,
        fs.statSync(path.join(repoRoot, relativePath)).mtimeMs,
      );
    } catch {
      // Treat an unreadable file as changed so it still gets a final pass.
    }
  }
  return mtimes;
}

// Returns whatever oxlint could not fix, what knip finds unused, and which
// related tests fail, when `report` is set.
async function formatFiles(repoRoot, relativePaths, { report = false } = {}) {
  if (relativePaths.length === 0 || !isInstrumentRepoRoot(repoRoot)) {
    return { lint: "", tests: "", unused: "" };
  }

  // Spelling first, so every pass below sees corrected text. Unfiltered by
  // extension on purpose: typos reads prose, shell scripts, and TOML as
  // readily as it reads code, and typos.toml is the one place that decides
  // what is in scope.
  await runBatched(repoRoot, relativePaths, runTypos);

  const oxfmtFiles = relativePaths.filter((relativePath) =>
    OXFMT_EXT.test(relativePath),
  );
  const lintFiles = relativePaths.filter((relativePath) =>
    LINT_EXT.test(relativePath),
  );

  await runBatched(repoRoot, oxfmtFiles, runOxfmt);

  const before = snapshotMtimes(repoRoot, lintFiles);
  const lintReport = await runBatched(repoRoot, lintFiles, (root, batch) =>
    runOxlint(root, batch, { report }),
  );

  // Lint fixes can change layout, so finish with oxfmt -- but only over the
  // files a fix actually rewrote.
  const after = snapshotMtimes(repoRoot, lintFiles);
  const rewritten = lintFiles.filter(
    (relativePath) =>
      OXFMT_EXT.test(relativePath) &&
      before.get(relativePath) !== after.get(relativePath),
  );
  await runBatched(repoRoot, rewritten, runOxfmt);

  // Last, over the code as the fixes left it: a fix that drops an unused
  // import can be what leaves an export unused, and the tests should see the
  // code that will be committed. The two read and never write, so they run
  // side by side.
  const [unused, tests] = report
    ? await Promise.all([
        runKnip(repoRoot, relativePaths),
        runRelatedTests(repoRoot, relativePaths),
      ])
    : ["", ""];

  return { lint: lintReport, tests, unused };
}

// PostToolUse stays deliberately cheap: a single oxfmt on the one file that
// changed. Lint autofixes are batched at Stop instead of paid per edit.
async function formatEditedFile({ filePath }) {
  const repoRoot = getCheckoutRoot(filePath);
  if (!repoRoot) {
    return;
  }
  const relativePath = getSafeRelativePath({ filePath, repoRoot });
  if (
    !relativePath ||
    !fileExists(filePath) ||
    !isInstrumentRepoRoot(repoRoot)
  ) {
    return;
  }
  if (IMMEDIATE_FORMAT_EXT.test(relativePath)) {
    await runOxfmt(repoRoot, [relativePath]);
  }
}

function truncate(report) {
  const maxLength = 6000;
  const body = report.trim();
  return body.length > maxLength
    ? `${body.slice(0, maxLength)}\n… (truncated)`
    : body;
}

function buildReason({ lint, tests, unused }) {
  const sections = [];
  if (lint.trim()) {
    sections.push(
      `oxlint reported problems that --fix could not resolve. Fix them before finishing:\n\n${truncate(lint)}`,
    );
  }
  if (unused.trim()) {
    sections.push(
      `knip found code and dependencies nothing uses in what you changed, which fails CI's check:unused. Delete or unexport each one, or remove the dependency, before finishing:\n\n${truncate(unused)}`,
    );
  }
  if (tests.trim()) {
    sections.push(
      `Tests that import what you changed fail, which fails CI's test:ci. Fix the code or the test before finishing. A failure in code you did not touch can be another agent's work in progress; if so, say that and leave it:\n\n${truncate(tests)}`,
    );
  }
  return sections.join("\n\n");
}

// -------------------------------------------------------------------------
// Event handling
// -------------------------------------------------------------------------

function getCodexEditedPaths(data) {
  const command =
    typeof data.tool_input?.command === "string" ? data.tool_input.command : "";
  const paths = new Set();

  for (const line of command.split("\n")) {
    const match = /^\*\*\* (?:Add|Update) File: (.+)$/.exec(line);
    if (match) {
      paths.add(match[1].trim());
    }
  }

  return [...paths];
}

// Cursor runtime delivers camelCase names; Claude Code delivers PascalCase.
function normalizeEventName(name) {
  if (name === "postToolUse") {
    return "PostToolUse";
  }
  if (name === "stop") {
    return "Stop";
  }
  return name;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(chunks.join("")));
    process.stdin.on("error", reject);
  });
}

async function handleStop({ data, repoRoot }) {
  if (getStopRoots({ data, repoRoot }).length === 0) {
    return "{}";
  }

  pruneSessionEdits();
  const editedPaths = takeSessionEdits(data.session_id);
  if (editedPaths.length === 0) {
    return "{}";
  }

  // Claude Code Stop only: hand remaining problems back to the agent so it
  // fixes them in-context instead of via a manual lint run. Other runtimes
  // (Codex "stop") do not honor the block contract, so they keep formatting
  // silently. Skip when stop_hook_active so the agent gets a single fix attempt
  // (no loops).
  const shouldReport =
    data.hook_event_name === "Stop" && data.stop_hook_active !== true;

  // Each file is checked from its own checkout, so a session that edited a
  // worktree and then left it still has that work checked by the worktree's
  // tools, not by whichever checkout the session ended in.
  const found = { lint: "", tests: "", unused: "" };
  for (const { relativePaths, repoRoot: root } of groupByCheckout(
    editedPaths,
  )) {
    const { lint, tests, unused } = await formatFiles(root, relativePaths, {
      report: shouldReport,
    });
    found.lint += lint;
    found.tests += tests;
    found.unused += unused;
  }

  const reason = buildReason(found);
  if (!reason) {
    return "{}";
  }
  return JSON.stringify({ decision: "block", reason });
}

async function handleEdit({ cwd, data, eventName }) {
  if (
    eventName === "afterFileEdit" &&
    typeof data.file_path === "string" &&
    data.file_path.length > 0
  ) {
    const filePath = path.resolve(data.file_path);
    await formatEditedFile({ filePath });
    recordSessionEdit(data.session_id, filePath);
    return;
  }

  if (eventName !== "PostToolUse") {
    return;
  }

  if (data.tool_name === "apply_patch") {
    const filePaths = getCodexEditedPaths(data).map((filePath) =>
      path.resolve(cwd, filePath),
    );
    await Promise.all(
      filePaths.map((filePath) => formatEditedFile({ filePath })),
    );
    for (const filePath of filePaths) {
      recordSessionEdit(data.session_id, filePath);
    }
    return;
  }

  if (
    (data.tool_name === "Edit" || data.tool_name === "Write") &&
    typeof data.tool_input?.file_path === "string" &&
    data.tool_input.file_path.length > 0
  ) {
    const filePath = path.resolve(data.tool_input.file_path);
    await formatEditedFile({ filePath });
    recordSessionEdit(data.session_id, filePath);
  }
}

const raw = await readStdin();
let data = {};
try {
  data = JSON.parse(raw || "{}");
} catch (error) {
  console.error("[format-hook] invalid JSON stdin", error.message);
  process.stdout.write("{}");
  // eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
  process.exit(0);
}

let result = "{}";
try {
  const cwd = process.cwd();
  const repoRoot = await getRepoRoot(cwd);
  const eventName = normalizeEventName(data.hook_event_name);

  if (eventName === "Stop") {
    result = await handleStop({ data, repoRoot });
  } else {
    await handleEdit({ cwd, data, eventName });
  }
} catch (error) {
  console.error("[format-hook]", error?.message ?? error);
}

process.stdout.write(result);
// eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
process.exit(0);
