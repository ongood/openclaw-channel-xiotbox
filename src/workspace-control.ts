import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep, win32 } from "node:path";

export const WORKSPACE_EXEC_MAX_TIMEOUT_MS = 3_600_000;
export const WORKSPACE_EXEC_MAX_ARGS = 256;
export const WORKSPACE_EXEC_MAX_OUTPUT_BYTES = 1_048_576;
export const WORKSPACE_EXEC_MAX_CONCURRENT = 4;
export const WORKSPACE_EXEC_RETENTION_MS = 3_600_000;

const SAFE_EXECUTABLES = new Set([
  "bun", "cargo", "dart", "deno", "flutter", "git", "go", "node", "npm", "npx", "pnpm",
  "poetry", "py.test", "pytest", "python", "python3", "tsc", "yarn",
]);
const SAFE_GIT_SUBCOMMANDS = new Set(["diff", "log", "rev-parse", "show", "status"]);
const PROJECT_VENV_PYTHON = /^(?:\.venv|venv)\/(?:bin\/(?:python|python3)|Scripts\/python(?:\.exe)?)$/i;

export interface WorkspaceControlRegistry {
  resolve(runtimeId: string, workspaceId: string): Promise<{
    localPath: string;
    readable: boolean;
    writable: boolean;
    executable: boolean;
  } | undefined>;
}

type ExecutionProfile = "safe" | "full.workspace";
type ExecutionStatus = "running" | "success" | "failed" | "timed_out" | "interrupted";

interface ExecutionRecord {
  executionId: string;
  runtimeId: string;
  workspaceId: string;
  executionProfile: ExecutionProfile;
  cwd: string;
  argv: string[];
  child: ChildProcess;
  status: ExecutionStatus;
  startedAt: number;
  completedAt?: number;
  exitCode?: number;
  signal?: string;
  stdout: Buffer[];
  stderr: Buffer[];
  outputBytes: number;
  truncated: boolean;
  timer: NodeJS.Timeout;
  interrupted: boolean;
}

const executions = new Map<string, ExecutionRecord>();

function required(payload: Record<string, unknown>, key: string): string {
  const value = String(payload[key] ?? "").trim();
  if (!value) throw new Error(`${key}_required`);
  return value;
}

function boundedTimeout(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > WORKSPACE_EXEC_MAX_TIMEOUT_MS) {
    throw new Error("workspace_exec_timeout_invalid");
  }
  return parsed;
}

function executionProfile(value: unknown): ExecutionProfile {
  const normalized = String(value ?? "safe").trim() || "safe";
  if (normalized === "safe" || normalized === "full.workspace") return normalized;
  throw new Error("workspace_exec_profile_invalid");
}

function within(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

async function resolveCwd(
  registry: WorkspaceControlRegistry,
  payload: Record<string, unknown>,
): Promise<{ runtimeId: string; workspaceId: string; root: string; cwd: string; cwdDisplay: string }> {
  const runtimeId = required(payload, "runtime_id");
  const workspaceId = required(payload, "workspace_id");
  const record = await registry.resolve(runtimeId, workspaceId);
  if (!record) throw new Error("WORKSPACE_NOT_FOUND");
  if (!record.readable) throw new Error("WORKSPACE_NOT_READABLE");
  if (!record.writable || !record.executable) throw new Error("WORKSPACE_NOT_EXECUTABLE");

  const root = await realpath(record.localPath);
  const raw = String(payload.cwd ?? ".").trim() || ".";
  if (raw.includes("\0") || isAbsolute(raw) || win32.isAbsolute(raw)) throw new Error("workspace_path_rejected");
  const lexical = resolve(root, raw);
  if (!within(root, lexical)) throw new Error("workspace_path_rejected");
  const cwd = await realpath(lexical).catch(() => { throw new Error("workspace_path_unavailable"); });
  if (!within(root, cwd)) throw new Error("workspace_symlink_escape");
  const info = await stat(cwd);
  if (!info.isDirectory()) throw new Error("workspace_directory_required");
  return {
    runtimeId,
    workspaceId,
    root,
    cwd,
    cwdDisplay: relative(root, cwd).replaceAll("\\", "/") || ".",
  };
}

function validateArgv(value: unknown, profile: ExecutionProfile): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > WORKSPACE_EXEC_MAX_ARGS) {
    throw new Error("workspace_exec_argv_invalid");
  }
  const argv = value.map((item) => String(item));
  if (argv.some((item) => !item || item.length > 8192 || item.includes("\0"))) {
    throw new Error("workspace_exec_argv_invalid");
  }
  if (profile === "full.workspace") return argv;

  const firstProgram = argv[0];
  if (firstProgram === undefined) throw new Error("workspace_exec_argv_invalid");
  const normalizedProgram = firstProgram.replaceAll("\\", "/");
  argv[0] = normalizedProgram;
  const projectPython = PROJECT_VENV_PYTHON.test(normalizedProgram);
  const executable = basename(normalizedProgram).toLowerCase().replace(/\.exe$/i, "");
  if ((!projectPython && (normalizedProgram.includes("/") || !SAFE_EXECUTABLES.has(executable)))
      || /(^|\/)\.\.(\/|$)/.test(normalizedProgram)) {
    throw new Error("workspace_exec_not_allowed");
  }
  if (executable === "git") {
    const subcommand = String(argv[1] ?? "").toLowerCase();
    if (subcommand !== "--version" && !SAFE_GIT_SUBCOMMANDS.has(subcommand)) {
      throw new Error("workspace_git_command_not_allowed");
    }
  }
  if (["bun", "deno", "node", "python", "python3"].includes(executable)) {
    const forbidden = new Set(["-c", "-e", "--eval", "-p", "--print"]);
    if (argv.slice(1).some((argument) => forbidden.has(argument) || argument.startsWith("--inspect"))) {
      throw new Error("workspace_exec_inline_code_not_allowed");
    }
  }
  for (const argument of argv.slice(1)) {
    if (isAbsolute(argument) || win32.isAbsolute(argument) || /(^|[\\/])\.\.([\\/]|$)/.test(argument)) {
      throw new Error("workspace_exec_argument_path_rejected");
    }
    if (/=[A-Za-z]:[\\/]/.test(argument) || argument.includes("=/")) {
      throw new Error("workspace_exec_argument_path_rejected");
    }
  }
  return argv;
}
function executionArgv(payload: Record<string, unknown>): { profile: ExecutionProfile; argv: string[] } {
  const profile = executionProfile(payload.execution_profile);
  const command = typeof payload.command === "string" ? payload.command : "";
  const hasCommand = command.trim().length > 0;
  const hasArgv = Array.isArray(payload.argv) && payload.argv.length > 0;
  if (hasCommand === hasArgv) throw new Error("workspace_exec_input_invalid");
  if (hasCommand) {
    if (profile !== "full.workspace") throw new Error("workspace_exec_shell_not_allowed");
    if (command.length > 65_536 || command.includes("\0")) throw new Error("workspace_exec_command_invalid");
    return {
      profile,
      argv: process.platform === "win32"
        ? ["cmd.exe", "/d", "/s", "/c", command]
        : ["/bin/sh", "-lc", command],
    };
  }
  return { profile, argv: validateArgv(payload.argv, profile) };
}

function minimalEnv(cwd: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { CI: "1", NO_COLOR: "1", HOME: cwd, USERPROFILE: cwd };
  for (const key of ["PATH", "Path", "LANG", "LC_ALL", "SystemRoot", "TEMP", "TMP", "TMPDIR", "WINDIR", "DOCKER_HOST", "DOCKER_CONTEXT"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

function appendOutput(record: ExecutionRecord, target: Buffer[], chunk: Buffer): void {
  const remaining = WORKSPACE_EXEC_MAX_OUTPUT_BYTES - record.outputBytes;
  if (remaining <= 0) {
    record.truncated = true;
    return;
  }
  const accepted = chunk.subarray(0, remaining);
  target.push(accepted);
  record.outputBytes += accepted.byteLength;
  if (accepted.byteLength < chunk.byteLength) record.truncated = true;
}

async function killTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((done) => {
      const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      killer.once("close", () => done());
      killer.once("error", () => { child.kill(); done(); });
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

function cleanup(now = Date.now()): void {
  for (const [id, execution] of executions) {
    if (execution.completedAt !== undefined && now - execution.completedAt > WORKSPACE_EXEC_RETENTION_MS) {
      executions.delete(id);
    }
  }
}

function snapshot(record: ExecutionRecord, includeOutput = false): Record<string, unknown> {
  return {
    execution_id: record.executionId,
    runtime_id: record.runtimeId,
    workspace_id: record.workspaceId,
    execution_profile: record.executionProfile,
    status: record.status,
    cwd: record.cwd,
    argv: record.argv,
    started_at_ms: record.startedAt,
    ...(record.completedAt !== undefined ? { completed_at_ms: record.completedAt, elapsed_ms: Math.max(0, record.completedAt - record.startedAt) } : { elapsed_ms: Math.max(0, Date.now() - record.startedAt) }),
    ...(record.exitCode !== undefined ? { exit_code: record.exitCode } : {}),
    ...(record.signal ? { signal: record.signal } : {}),
    truncated: record.truncated,
    ...(includeOutput ? {
      stdout: Buffer.concat(record.stdout).toString("utf8"),
      stderr: Buffer.concat(record.stderr).toString("utf8"),
    } : {}),
  };
}

function requireExecution(payload: Record<string, unknown>): ExecutionRecord {
  cleanup();
  const executionId = required(payload, "execution_id");
  const record = executions.get(executionId);
  if (!record || record.runtimeId !== required(payload, "runtime_id") || record.workspaceId !== required(payload, "workspace_id")) {
    throw new Error("workspace_execution_not_found");
  }
  return record;
}

async function startExecution(registry: WorkspaceControlRegistry, payload: Record<string, unknown>): Promise<ExecutionRecord> {
  cleanup();
  const running = [...executions.values()].filter((item) => item.status === "running").length;
  if (running >= WORKSPACE_EXEC_MAX_CONCURRENT) throw new Error("workspace_exec_capacity_exceeded");

  const target = await resolveCwd(registry, payload);
  const { profile, argv } = executionArgv(payload);
  const timeoutMs = boundedTimeout(payload.timeout_ms, 120_000);
  const executionId = `wexec_${randomUUID()}`;
  const child = spawn(argv[0]!, argv.slice(1), {
    cwd: target.cwd,
    env: minimalEnv(target.cwd),
    detached: process.platform !== "win32",
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const record: ExecutionRecord = {
    executionId,
    runtimeId: target.runtimeId,
    workspaceId: target.workspaceId,
    executionProfile: profile,
    cwd: target.cwdDisplay,
    argv,
    child,
    status: "running",
    startedAt: Date.now(),
    stdout: [],
    stderr: [],
    outputBytes: 0,
    truncated: false,
    timer: setTimeout(() => {
      if (record.status !== "running") return;
      record.status = "timed_out";
      record.completedAt = Date.now();
      void killTree(child);
    }, timeoutMs),
    interrupted: false,
  };
  executions.set(executionId, record);

  child.stdout?.on("data", (chunk: Buffer) => appendOutput(record, record.stdout, chunk));
  child.stderr?.on("data", (chunk: Buffer) => appendOutput(record, record.stderr, chunk));
  child.once("error", (error: NodeJS.ErrnoException) => {
    clearTimeout(record.timer);
    record.status = "failed";
    record.completedAt = Date.now();
    record.exitCode = -1;
    appendOutput(record, record.stderr, Buffer.from(error.code === "ENOENT" ? "workspace_exec_executable_unavailable" : "workspace_exec_failed"));
  });
  child.once("close", (code, signal) => {
    clearTimeout(record.timer);
    if (record.status === "running") record.status = code === 0 ? "success" : "failed";
    if (record.interrupted) record.status = "interrupted";
    if (record.completedAt === undefined) record.completedAt = Date.now();
    record.exitCode = typeof code === "number" ? code : -1;
    if (signal) record.signal = signal;
  });
  return record;
}

async function runShort(registry: WorkspaceControlRegistry, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const record = await startExecution(registry, payload);
  await new Promise<void>((resolveDone) => {
    if (record.status !== "running") { resolveDone(); return; }
    const settle = () => resolveDone();
    record.child.once("close", settle);
    record.child.once("error", settle);
  });
  return snapshot(record, true);
}

export async function executeWorkspaceControl(
  registry: WorkspaceControlRegistry,
  commandType: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (commandType === "workspace.exec") return runShort(registry, payload);
  if (commandType === "workspace.exec.start") return snapshot(await startExecution(registry, payload));
  if (commandType === "workspace.exec.status" || commandType === "workspace.exec.output" || commandType === "workspace.exec.interrupt") {
    await resolveCwd(registry, payload);
    const record = requireExecution(payload);
    if (commandType === "workspace.exec.status") return snapshot(record);
    if (commandType === "workspace.exec.output") return snapshot(record, true);
    if (record.status !== "running") return { ...snapshot(record), interrupt_requested: false };
    record.interrupted = true;
    record.status = "interrupted";
    record.completedAt = Date.now();
    clearTimeout(record.timer);
    await killTree(record.child);
    return { ...snapshot(record), interrupt_requested: true };
  }
  throw new Error("workspace_control_command_unsupported");
}
