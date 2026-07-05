import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PRETTIER_EXT =
  /\.(?:ts|tsx|mjs|cjs|js|jsx|json|css|scss|md|yaml|yml|html)$/i;
const ESLINT_EXT = /\.(?:ts|tsx|mjs|cjs|js|jsx)$/i;

const INSTRUMENT_ROOT_NAMES = new Set([
  "@instrument-org/monorepo",
  "@instrument-org/skills",
  "@instrument/internal",
]);

function fileExists(filePath) {
  try {
    if (!fs.statSync(filePath).isFile()) {
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function findEslintConfigDirectory(repoRoot, filePath) {
  // Walk up from the file's directory to find the nearest eslint.config.*,
  // stopping at the repo root. ESLint must run from this directory so that
  // package-level settings (e.g. better-tailwindcss entryPoint) apply.
  let directory = path.dirname(path.resolve(filePath));
  const root = path.resolve(repoRoot);
  while (directory.startsWith(root) && directory !== root) {
    for (const name of [
      "eslint.config.ts",
      "eslint.config.mts",
      "eslint.config.js",
      "eslint.config.mjs",
    ]) {
      if (fileExists(path.join(directory, name))) {
        return directory;
      }
    }
    directory = path.dirname(directory);
  }
  return root;
}

function formatDirtyFiles(repoRoot) {
  if (!isInstrumentRepoRoot(repoRoot)) {
    return;
  }

  const existing = listDirtyPaths(repoRoot).filter((relativePath) => {
    if (shouldSkipRelative(relativePath)) {
      return false;
    }
    return fileExists(path.join(repoRoot, relativePath));
  });

  const prettierFiles = existing.filter((relativePath) =>
    PRETTIER_EXT.test(relativePath),
  );
  const eslintFiles = existing.filter((relativePath) =>
    ESLINT_EXT.test(relativePath),
  );

  runBatched(repoRoot, prettierFiles, runPrettier);
  runBatched(repoRoot, eslintFiles, runEslint);

  // ESLint fixes can change layout, so finish with Prettier.
  runBatched(repoRoot, prettierFiles, runPrettier);
}

// Per-session record of files this session edited, so the Stop report only
// blocks on the agent's own work -- never on files a *parallel* agent left
// dirty in the same repo. Keyed by session id, stored outside the repo.
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

function readSessionEdits(sessionId) {
  if (!sessionId) {
    return [];
  }
  try {
    const content = fs.readFileSync(sessionEditsFile(sessionId), "utf8");
    return [
      ...new Set(
        content
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
      ),
    ];
  } catch {
    return [];
  }
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

function lintReportSessionEdits({ editedPaths, repoRoot }) {
  if (!isInstrumentRepoRoot(repoRoot)) {
    return "";
  }

  const eslintFiles = [
    ...new Set(
      editedPaths
        .map((absolutePath) => getSafeRelativePath({ filePath: absolutePath, repoRoot }))
        .filter(
          (relativePath) =>
            relativePath &&
            ESLINT_EXT.test(relativePath) &&
            fileExists(path.join(repoRoot, relativePath)),
        ),
    ),
  ];

  return runBatched(repoRoot, eslintFiles, (root, batch) =>
    runEslint(root, batch, { report: true }),
  );
}

function formatEditedFile({ filePath, repoRoot }) {
  const relativePath = getSafeRelativePath({ filePath, repoRoot });
  if (!relativePath || !fileExists(filePath)) {
    return;
  }

  if (!isInstrumentRepoRoot(repoRoot)) {
    return;
  }

  if (PRETTIER_EXT.test(relativePath)) {
    runPrettier(repoRoot, [relativePath]);
  }
}

function formatEditedFiles({ cwd, filePaths, repoRoot }) {
  const relativePaths = filePaths
    .map((filePath) =>
      getSafeRelativePath({
        filePath: path.resolve(cwd, filePath),
        repoRoot,
      }),
    )
    .filter(
      (relativePath) =>
        relativePath && fileExists(path.join(repoRoot, relativePath)),
    );

  if (relativePaths.length === 0 || !isInstrumentRepoRoot(repoRoot)) {
    return;
  }

  const prettierFiles = relativePaths.filter((relativePath) =>
    PRETTIER_EXT.test(relativePath),
  );
  const eslintFiles = relativePaths.filter((relativePath) =>
    ESLINT_EXT.test(relativePath),
  );

  runBatched(repoRoot, prettierFiles, runPrettier);
  runBatched(repoRoot, eslintFiles, runEslint);
  runBatched(repoRoot, prettierFiles, runPrettier);
}

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

function getRepoRoot(cwd) {
  const root = readGitPaths(cwd, ["rev-parse", "--show-toplevel"]).trim();
  return root || cwd;
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

  const primaryRoot = [...instrumentRoots].sort()[0];
  if (path.resolve(repoRoot) !== primaryRoot) {
    return [];
  }
  return instrumentRoots;
}

function isInstrumentRepoRoot(repoRoot) {
  const packagePath = path.join(repoRoot, "package.json");
  if (!fs.existsSync(packagePath)) {
    return false;
  }

  let package_;
  try {
    package_ = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  } catch {
    return false;
  }

  if (!INSTRUMENT_ROOT_NAMES.has(package_.name)) {
    return false;
  }

  try {
    fs.statSync(path.join(repoRoot, ".git"));
  } catch {
    return false;
  }

  return true;
}

function listDirtyPaths(repoRoot) {
  const lines = [
    readGitPaths(repoRoot, [
      "diff",
      "--name-only",
      "--ignore-submodules=all",
      "HEAD",
      "--",
      ":!registry",
    ]),
    readGitPaths(repoRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      ":!registry",
    ]),
  ];

  const dirty = new Set();
  for (const line of lines.join("\n").split("\n")) {
    const relativePath = line.trim();
    if (relativePath) {
      dirty.add(relativePath);
    }
  }
  return [...dirty];
}

function readGitPaths(repoRoot, arguments_) {
  try {
    return execFileSync("git", arguments_, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return typeof error.stdout === "string" ? error.stdout : "";
  }
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

function runBatched(repoRoot, files, run) {
  const batchSize = 40;
  let output = "";
  for (let index = 0; index < files.length; index += batchSize) {
    const result = run(repoRoot, files.slice(index, index + batchSize));
    if (typeof result === "string" && result) {
      output += result;
    }
  }
  return output;
}

function runEslint(repoRoot, files, { report = false } = {}) {
  if (files.length === 0) {
    return "";
  }
  const eslintPath = path.join(repoRoot, "node_modules/.bin/eslint");
  if (!fileExists(eslintPath)) {
    return "";
  }
  // The fast autofix pass uses the formatting-only config (no typed rules, so
  // it skips TypeScript project startup). The Stop reporting pass uses each
  // package's real eslint.config.* instead, so results match `check:lint`
  // exactly (no false positives such as react/react-in-jsx-scope, no missed
  // typed rules).
  const formatConfigPath = path.join(
    repoRoot,
    "packages/eslint-config/format.ts",
  );
  const configArguments =
    !report && fileExists(formatConfigPath)
      ? ["--config", formatConfigPath]
      : [];
  // Reporting mode is read-only and treats warnings as failures, matching
  // `eslint . --max-warnings 0` (check:lint). The autofix pass keeps --fix.
  const warningArguments = report ? ["--max-warnings=0"] : [];
  const fixArguments = report ? [] : ["--fix"];

  // Group files by their nearest eslint.config directory so each group runs
  // with the correct cwd (and thus the correct package-level config).
  const groups = new Map();
  for (const relativePath of files) {
    const configDirectory = findEslintConfigDirectory(
      repoRoot,
      path.join(repoRoot, relativePath),
    );
    if (!groups.has(configDirectory)) {
      groups.set(configDirectory, []);
    }
    groups.get(configDirectory).push(path.resolve(repoRoot, relativePath));
  }

  let output = "";
  for (const [configDirectory, absolutePaths] of groups) {
    try {
      execFileSync(
        eslintPath,
        [
          ...configArguments,
          "--no-ignore",
          ...warningArguments,
          ...fixArguments,
          ...absolutePaths,
        ],
        {
          cwd: configDirectory,
          encoding: "utf8",
          maxBuffer: 50 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
    } catch (error) {
      // ESLint exits 1 for problems that --fix could not resolve. In reporting
      // mode, capture the remaining problems so the Stop branch can surface
      // them to the agent.
      if (report) {
        const remaining =
          typeof error.stdout === "string" ? error.stdout : "";
        if (remaining.trim()) {
          output += remaining;
        }
      }
    }
  }
  return output;
}

function runPrettier(repoRoot, files) {
  if (files.length === 0) {
    return;
  }
  const prettierPath = path.join(repoRoot, "node_modules/.bin/prettier");
  if (!fileExists(prettierPath)) {
    return;
  }
  execFileSync(prettierPath, ["--write", ...files], {
    cwd: repoRoot,
    maxBuffer: 50 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function buildLintReason(report) {
  const maxLength = 6000;
  let body = report.trim();
  if (body.length > maxLength) {
    body = `${body.slice(0, maxLength)}\n… (truncated)`;
  }
  return `ESLint reported problems that --fix could not resolve. Fix them before finishing:\n\n${body}`;
}

function shouldSkipRelative(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  return (
    normalized.startsWith("registry/") ||
    normalized.startsWith("node_modules/") ||
    normalized.includes("/node_modules/")
  );
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
  const repoRoot = getRepoRoot(cwd);

  // Cursor runtime delivers camelCase names; Claude Code delivers PascalCase.
  // Normalize to PascalCase so the branches below work for both runtimes.
  const eventName = (() => {
    const n = data.hook_event_name;
    if (n === "postToolUse") {
      return "PostToolUse";
    }
    if (n === "stop") {
      return "Stop";
    }
    return n;
  })();

  if (
    eventName === "afterFileEdit" &&
    typeof data.file_path === "string" &&
    data.file_path.length > 0
  ) {
    const filePath = path.resolve(data.file_path);
    formatEditedFile({ filePath, repoRoot });
    recordSessionEdit(data.session_id, filePath);
  }

  if (eventName === "Stop") {
    const roots = getStopRoots({ data, repoRoot });
    for (const root of roots) {
      formatDirtyFiles(root);
    }

    // Claude Code Stop only: run each package's real ESLint config over the
    // files THIS session edited and hand any remaining problems back to the
    // agent so it fixes them in-context instead of via a manual lint run. We
    // scope to the session's own edits (not the whole dirty set) so a parallel
    // agent's in-flight files never block this one. The format pass above uses
    // a fast formatting-only config for autofixes; reporting uses the real
    // config so results match `check:lint`. Other runtimes (Codex "stop") do
    // not honor the block contract, so they keep formatting silently. Skip when
    // stop_hook_active so the agent gets a single fix attempt (no loops).
    if (data.hook_event_name === "Stop" && data.stop_hook_active !== true) {
      pruneSessionEdits();
      const editedPaths = readSessionEdits(data.session_id);
      if (editedPaths.length > 0) {
        let lintReport = "";
        for (const root of roots) {
          lintReport += lintReportSessionEdits({ editedPaths, repoRoot: root });
        }
        if (lintReport.trim()) {
          result = JSON.stringify({
            decision: "block",
            reason: buildLintReason(lintReport),
          });
        }
      }
    }
  }

  if (eventName === "PostToolUse" && data.tool_name === "apply_patch") {
    const filePaths = getCodexEditedPaths(data);
    formatEditedFiles({ cwd, filePaths, repoRoot });
    for (const filePath of filePaths) {
      recordSessionEdit(data.session_id, path.resolve(cwd, filePath));
    }
  }

  if (
    eventName === "PostToolUse" &&
    (data.tool_name === "Edit" || data.tool_name === "Write") &&
    typeof data.tool_input?.file_path === "string" &&
    data.tool_input.file_path.length > 0
  ) {
    const filePath = path.resolve(data.tool_input.file_path);
    formatEditedFile({ filePath, repoRoot });
    recordSessionEdit(data.session_id, filePath);
  }
} catch (error) {
  console.error("[format-hook]", error?.message ?? error);
}

process.stdout.write(result);
// eslint-disable-next-line n/no-process-exit, unicorn/no-process-exit
process.exit(0);
