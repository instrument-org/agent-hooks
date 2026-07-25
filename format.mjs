import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const OXFMT_EXT =
  /\.(?:ts|tsx|mjs|cjs|js|jsx|json|jsonc|css|md|mdx|yaml|yml|html)$/i;
const ESLINT_EXT = /\.(?:ts|tsx|mjs|cjs|js|jsx)$/i;

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
// what the hook actually spends its time on. Batches and eslint config groups
// are therefore dispatched concurrently; this pool is the single place that
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

// Resolve session-edit absolute paths against one root, dropping anything
// outside it or since deleted.
function toExistingRelativePaths({ paths, repoRoot }) {
  const relativePaths = paths
    .map((filePath) => getSafeRelativePath({ filePath, repoRoot }))
    .filter(
      (relativePath) =>
        relativePath && fileExists(path.join(repoRoot, relativePath)),
    );
  return [...new Set(relativePaths)];
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

const eslintConfigDirectoryCache = new Map();

// ESLint flat config does not cascade, so each package's eslint.config.* only
// applies when ESLint runs from that package directory (e.g. better-tailwindcss
// entryPoint). Walk up from the file to find the nearest one, stopping at the
// repo root.
function findEslintConfigDirectory(repoRoot, filePath) {
  const startDirectory = path.dirname(path.resolve(filePath));
  const cached = eslintConfigDirectoryCache.get(startDirectory);
  if (cached !== undefined) {
    return cached;
  }

  const root = path.resolve(repoRoot);
  let directory = startDirectory;
  let found = root;
  while (directory.startsWith(root) && directory !== root) {
    const hasConfig = [
      "eslint.config.ts",
      "eslint.config.mts",
      "eslint.config.js",
      "eslint.config.mjs",
    ].some((name) => fileExists(path.join(directory, name)));
    if (hasConfig) {
      found = directory;
      break;
    }
    directory = path.dirname(directory);
  }

  eslintConfigDirectoryCache.set(startDirectory, found);
  return found;
}

function groupByEslintConfigDirectory(repoRoot, relativePaths) {
  const groups = new Map();
  for (const relativePath of relativePaths) {
    const configDirectory = findEslintConfigDirectory(
      repoRoot,
      path.join(repoRoot, relativePath),
    );
    if (!groups.has(configDirectory)) {
      groups.set(configDirectory, []);
    }
    groups.get(configDirectory).push(path.resolve(repoRoot, relativePath));
  }
  return groups;
}

// Fixing and reporting are one pass, not two. ESLint no longer builds a
// TypeScript program (type-aware rules moved to oxlint), so each package's real
// eslint.config.* is cheap enough to autofix with -- and running it means what
// --fix leaves behind is exactly what `check:lint` would report, from a single
// spawn instead of a formatting-config pass plus a reporting pass.
async function runEslintFix(repoRoot, files, { report = false } = {}) {
  if (files.length === 0) {
    return "";
  }
  const eslintPath = path.join(repoRoot, "node_modules/.bin/eslint");
  if (!fileExists(eslintPath)) {
    return "";
  }

  // --max-warnings=0 matches `eslint . --max-warnings 0` (check:lint), so
  // warnings the fixer could not resolve still reach the agent.
  const reportArguments = report ? ["--max-warnings=0"] : [];

  const groups = groupByEslintConfigDirectory(repoRoot, files);
  const outputs = await Promise.all(
    [...groups].map(async ([configDirectory, absolutePaths]) => {
      const { ok, stdout } = await execTool(
        eslintPath,
        ["--no-ignore", "--fix", ...reportArguments, ...absolutePaths],
        { cwd: configDirectory },
      );
      // ESLint exits non-zero for problems --fix could not resolve; those are
      // what the Stop branch hands back to the agent.
      return report && !ok && stdout.trim() ? stdout : "";
    }),
  );
  return outputs.join("");
}

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

async function runOxlintFix(repoRoot, files) {
  if (files.length === 0) {
    return "";
  }
  const oxlintPath = path.join(repoRoot, "node_modules/.bin/oxlint");
  if (!fileExists(oxlintPath)) {
    return "";
  }
  // No --type-aware, so it skips tsgolint / TS project startup while still
  // applying JS-plugin fixes (e.g. tailwindcss class sort-order) the eslint
  // pass never covered. Run from repoRoot so oxlint resolves each file's
  // nearest .oxlintrc.json. Unfixable problems surface via check:lint.
  await execTool(oxlintPath, ["--fix", ...files], { cwd: repoRoot });
  return "";
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

// Returns whatever ESLint could not fix, when `report` is set.
async function formatFiles(repoRoot, relativePaths, { report = false } = {}) {
  if (relativePaths.length === 0 || !isInstrumentRepoRoot(repoRoot)) {
    return "";
  }

  const oxfmtFiles = relativePaths.filter((relativePath) =>
    OXFMT_EXT.test(relativePath),
  );
  const lintFiles = relativePaths.filter((relativePath) =>
    ESLINT_EXT.test(relativePath),
  );

  await runBatched(repoRoot, oxfmtFiles, runOxfmt);

  const before = snapshotMtimes(repoRoot, lintFiles);
  // oxlint first so ESLint reports against the already-fixed content and the
  // report reflects what actually remains.
  await runBatched(repoRoot, lintFiles, runOxlintFix);
  const lintReport = await runBatched(repoRoot, lintFiles, (root, batch) =>
    runEslintFix(root, batch, { report }),
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

  return lintReport;
}

// PostToolUse stays deliberately cheap: a single oxfmt on the one file that
// changed. Lint autofixes are batched at Stop instead of paid per edit.
async function formatEditedFile({ filePath, repoRoot }) {
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

function buildLintReason(report) {
  const maxLength = 6000;
  let body = report.trim();
  if (body.length > maxLength) {
    body = `${body.slice(0, maxLength)}\n… (truncated)`;
  }
  return `ESLint reported problems that --fix could not resolve. Fix them before finishing:\n\n${body}`;
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
  const roots = getStopRoots({ data, repoRoot });
  if (roots.length === 0) {
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

  let lintReport = "";
  for (const root of roots) {
    const relativePaths = toExistingRelativePaths({
      paths: editedPaths,
      repoRoot: root,
    });
    if (relativePaths.length === 0) {
      continue;
    }
    lintReport += await formatFiles(root, relativePaths, {
      report: shouldReport,
    });
  }

  if (!lintReport.trim()) {
    return "{}";
  }
  return JSON.stringify({
    decision: "block",
    reason: buildLintReason(lintReport),
  });
}

async function handleEdit({ cwd, data, eventName, repoRoot }) {
  if (
    eventName === "afterFileEdit" &&
    typeof data.file_path === "string" &&
    data.file_path.length > 0
  ) {
    const filePath = path.resolve(data.file_path);
    await formatEditedFile({ filePath, repoRoot });
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
      filePaths.map((filePath) => formatEditedFile({ filePath, repoRoot })),
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
    await formatEditedFile({ filePath, repoRoot });
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
    await handleEdit({ cwd, data, eventName, repoRoot });
  }
} catch (error) {
  console.error("[format-hook]", error?.message ?? error);
}

process.stdout.write(result);
// eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
process.exit(0);
