import { createHash, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { performance } from 'node:perf_hooks'

export const WORKSPACE_CONTROL_MAX_BYTES = 1_048_576
export const WORKSPACE_CONTROL_MAX_ENTRIES = 2_000
export const WORKSPACE_EXEC_MAX_TIMEOUT_MS = 3_600_000
export const WORKSPACE_EXEC_MAX_ARGS = 128
export const WORKSPACE_SEARCH_MAX_FILE_BYTES = 2_097_152
export const WORKSPACE_READ_RANGE_MAX_FILE_BYTES = 16_777_216
export const WORKSPACE_EXEC_MAX_CONCURRENT = 4
export const WORKSPACE_EXEC_RETENTION_MS = 3_600_000

const EXECUTABLE_ALLOWLIST = new Set([
  'bun', 'cargo', 'dart', 'deno', 'flutter', 'git', 'go', 'node', 'npm', 'npx', 'pnpm',
  'poetry', 'py.test', 'pytest', 'python', 'python3', 'tsc', 'yarn',
])
const GIT_EXEC_SUBCOMMAND_ALLOWLIST = new Set([
  'diff', 'log', 'rev-parse', 'show', 'status',
])
const PROJECT_VENV_PYTHON = /^(?:\.venv|venv)\/(?:bin\/(?:python|python3)|Scripts\/python(?:\.exe)?)$/i
const SEARCH_IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.next', '.npm-cache', 'build', 'coverage', 'dist',
  'node_modules', 'target', '__pycache__',
])
const XIOTBOX_REPOSITORY = /^xiotbox\/([A-Za-z0-9._-]{1,100})$/i

export interface WorkspaceControlRegistry {
  resolve(runtimeId: string, workspaceId: string): Promise<{
    localPath: string
    readable: boolean
    writable: boolean
    executable: boolean
  } | undefined>
}

export type NewlineStyle = 'none' | 'LF' | 'CRLF' | 'MIXED'

export type NewlineMode = 'preserve' | 'exact'

export function detectNewlineStyle(text: string): NewlineStyle {
  if (!text.includes('\n')) return 'none'
  let bareLf = 0
  let crlf = 0
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    if (index > 0 && text[index - 1] === '\r') crlf += 1
    else bareLf += 1
  }
  if (bareLf === 0) return 'CRLF'
  if (crlf === 0) return 'LF'
  return 'MIXED'
}

export function convertNewlines(text: string, style: 'LF' | 'CRLF'): string {
  if (style === 'CRLF') return text.replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')
  return text.replaceAll('\r\n', '\n')
}

function dominantNewlineStyle(source: string): 'LF' | 'CRLF' {
  let crlf = 0
  let bareLf = 0
  for (let index = source.indexOf('\n'); index >= 0; index = source.indexOf('\n', index + 1)) {
    if (index > 0 && source[index - 1] === '\r') crlf += 1
    else bareLf += 1
  }
  return crlf > bareLf ? 'CRLF' : 'LF'
}

function normalizedWithOriginalEnds(source: string): { normalized: string, ends: Uint32Array } {
  const characters: string[] = []
  const ends = new Uint32Array(source.length)
  let normalizedLength = 0
  let index = 0
  while (index < source.length) {
    const paired = source[index] === '\r' && source[index + 1] === '\n'
    characters.push(paired ? '\n' : source[index])
    index += paired ? 2 : 1
    ends[normalizedLength] = index
    normalizedLength += 1
  }
  return { normalized: characters.join(''), ends: ends.subarray(0, normalizedLength) }
}

function throwPatchError(message: string, details: Record<string, unknown>): never {
  const error = new Error(message) as Error & { details?: Record<string, unknown> }
  error.details = details
  throw error
}

export interface NewlineAwarePatchResult {
  text: string
  replaced: number
  fileNewline: NewlineStyle
  requestNewline: NewlineStyle
}

/**
 * Match `oldText` in `source` with `\r\n`/`\n` differences normalized away and
 * splice in `newText` converted to the surrounding file's newline convention.
 * Throws the same error messages as the exact path, with structured `details`
 * so callers can tell newline mismatch apart from genuinely missing text.
 * Only `\r\n` ↔ `\n` differences are reconciled; lone `\r` bytes stay literal.
 */
export function applyNewlineAwarePatch(
  source: string,
  oldText: string,
  newText: string,
  options: { replaceAll: boolean },
): NewlineAwarePatchResult {
  const fileNewline = detectNewlineStyle(source)
  const requestNewline = detectNewlineStyle(oldText)
  const { normalized, ends } = normalizedWithOriginalEnds(source)
  const normalizedOld = oldText.replaceAll('\r\n', '\n')
  const positions: number[] = []
  for (let index = normalized.indexOf(normalizedOld); index >= 0; index = normalized.indexOf(normalizedOld, index + Math.max(normalizedOld.length, 1))) {
    positions.push(index)
  }
  if (positions.length === 0) {
    throwPatchError('workspace_patch_old_text_not_found', {
      reason: 'missing_after_normalization',
      file_newline: fileNewline,
      request_newline: requestNewline,
      normalized_match_count: 0,
      error_code: 'workspace_patch_old_text_not_found',
    })
  }
  if (positions.length !== 1 && options.replaceAll !== true) {
    throwPatchError('workspace_patch_ambiguous', {
      reason: 'ambiguous_after_normalization',
      normalized_match_count: positions.length,
      error_code: 'workspace_patch_old_text_ambiguous',
    })
  }
  const dominant = dominantNewlineStyle(source)
  const regionStyle = (originalStart: number): 'LF' | 'CRLF' => {
    if (fileNewline === 'CRLF') return 'CRLF'
    if (fileNewline !== 'MIXED') return 'LF'
    const lastNewline = originalStart > 0 ? source.lastIndexOf('\n', originalStart - 1) : -1
    if (lastNewline < 0) return dominant
    return lastNewline > 0 && source[lastNewline - 1] === '\r' ? 'CRLF' : 'LF'
  }
  const selected = options.replaceAll ? positions : [positions[0]]
  let result = ''
  let cursor = 0
  for (const start of selected) {
    const end = start + normalizedOld.length
    const originalStart = start === 0 ? 0 : ends[start - 1]
    const originalEnd = ends[end - 1]
    result += source.slice(cursor, originalStart)
    result += convertNewlines(newText, regionStyle(originalStart))
    cursor = originalEnd
  }
  result += source.slice(cursor)
  return { text: result, replaced: selected.length, fileNewline, requestNewline }
}

function parseNewlineMode(value: unknown): NewlineMode {
  if (value === undefined) return 'preserve'
  if (value === 'preserve' || value === 'exact') return value
  throw new Error('workspace_patch_newline_mode_invalid')
}

function required(payload: Record<string, unknown>, key: string): string {
  const value = String(payload[key] ?? '').trim()
  if (value.length === 0) throw new Error(`${key}_required`)
  return value
}

function requiredRaw(payload: Record<string, unknown>, key: string): string {
  const value = payload[key]
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${key}_required`)
  return value
}

function within(root: string, candidate: string): boolean {
  const relation = relative(root, candidate)
  return relation === '' || (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
}

function normalizedRelativePath(value: unknown, fallback = '.'): string {
  const requested = String(value ?? fallback).trim() || fallback
  if (requested.includes('\u0000') || isAbsolute(requested) || win32.isAbsolute(requested)) {
    throw new Error('workspace_path_rejected')
  }
  return requested.replaceAll('\\', '/')
}

async function resolveWorkspace(
  registry: WorkspaceControlRegistry,
  payload: Record<string, unknown>,
  mode: 'read' | 'write' | 'exec',
): Promise<{ root: string }> {
  const runtimeId = required(payload, 'runtime_id')
  const workspaceId = required(payload, 'workspace_id')
  const record = await registry.resolve(runtimeId, workspaceId)
  if (record === undefined) throw new Error('WORKSPACE_NOT_FOUND')
  if (!record.readable) throw new Error('WORKSPACE_NOT_READABLE')
  if (mode === 'write' && !record.writable) throw new Error('WORKSPACE_NOT_WRITABLE')
  if (mode === 'exec' && (!record.writable || !record.executable)) throw new Error('WORKSPACE_NOT_EXECUTABLE')
  return { root: await realpath(record.localPath) }
}

async function workspaceTarget(
  registry: WorkspaceControlRegistry,
  payload: Record<string, unknown>,
  mode: 'read' | 'write' | 'exec',
  pathKey = 'path',
): Promise<{ root: string, target: string, relativePath: string }> {
  const { root } = await resolveWorkspace(registry, payload, mode)
  const requested = normalizedRelativePath(payload[pathKey])
  const lexical = resolve(root, requested)
  if (!within(root, lexical)) throw new Error('workspace_path_rejected')

  let target: string
  try {
    target = await realpath(lexical)
  } catch (error) {
    if (mode === 'read' || (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('workspace_path_unavailable')
    }
    let existingAncestor = dirname(lexical)
    let parent: string | undefined
    while (within(root, existingAncestor)) {
      try {
        parent = await realpath(existingAncestor)
        break
      } catch (parentError) {
        if ((parentError as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('workspace_parent_unavailable')
        if (existingAncestor === root) break
        existingAncestor = dirname(existingAncestor)
      }
    }
    if (parent === undefined || !within(root, parent)) throw new Error('workspace_parent_unavailable')
    if (dirname(lexical) !== existingAncestor && payload.create_parents !== true && payload.recursive !== true) {
      throw new Error('workspace_parent_unavailable')
    }
    target = resolve(parent, relative(existingAncestor, lexical))
  }
  if (!within(root, target)) throw new Error('workspace_symlink_escape')
  return { root, target, relativePath: relative(root, target).replaceAll('\\', '/') || '.' }
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

async function currentFile(target: string): Promise<{ content: Buffer, sha256: string }> {
  const info = await stat(target)
  if (!info.isFile()) throw new Error('workspace_file_required')
  if (info.size > WORKSPACE_CONTROL_MAX_BYTES) throw new Error('workspace_file_too_large')
  const content = await readFile(target)
  return { content, sha256: sha256(content) }
}

async function atomicWrite(target: string, content: Buffer): Promise<void> {
  const parent = dirname(target)
  const temporary = join(parent, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content, { flag: 'wx' })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, error: string): number {
  const parsed = Number(value ?? fallback)
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(error)
  return parsed
}

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { bytes: number, truncated: boolean }): void {
  if (state.bytes >= WORKSPACE_CONTROL_MAX_BYTES) {
    state.truncated = true
    return
  }
  const remaining = WORKSPACE_CONTROL_MAX_BYTES - state.bytes
  const accepted = chunk.subarray(0, remaining)
  chunks.push(accepted)
  state.bytes += accepted.byteLength
  if (accepted.byteLength < chunk.byteLength) state.truncated = true
}

type WorkspaceExecutionProfile = 'safe' | 'full.workspace'

function workspaceExecutionProfile(value: unknown): WorkspaceExecutionProfile {
  const profile = String(value ?? 'safe').trim() || 'safe'
  if (profile === 'safe' || profile === 'full.workspace') return profile
  throw new Error('workspace_exec_profile_invalid')
}

function validateExecArgv(value: unknown, profile: WorkspaceExecutionProfile = 'safe'): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > WORKSPACE_EXEC_MAX_ARGS) {
    throw new Error('workspace_exec_argv_invalid')
  }
  const argv = value.map((item) => String(item))
  if (argv.some((item) => item.length === 0 || item.length > 4_096 || item.includes('\u0000'))) {
    throw new Error('workspace_exec_argv_invalid')
  }
  const normalizedProgram = argv[0].replaceAll('\\', '/')
  argv[0] = normalizedProgram
  if (profile === 'full.workspace') return argv

  const projectPython = PROJECT_VENV_PYTHON.test(normalizedProgram)
  const executable = basename(normalizedProgram).toLowerCase().replace(/\.exe$/i, '')
  if ((!projectPython && (normalizedProgram.includes('/') || !EXECUTABLE_ALLOWLIST.has(executable)))
      || /(^|\/)\.\.(\/|$)/.test(normalizedProgram)) {
    throw new Error('workspace_exec_not_allowed')
  }
  if (executable === 'git') {
    const subcommand = String(argv[1] ?? '').toLowerCase()
    if (subcommand === '--version') return argv
    if (!GIT_EXEC_SUBCOMMAND_ALLOWLIST.has(subcommand)) throw new Error('workspace_git_command_not_allowed')
  }
  if (['bun', 'deno', 'node', 'python', 'python3'].includes(executable)) {
    const forbidden = new Set(['-c', '-e', '--eval', '-p', '--print'])
    if (argv.slice(1).some((argument) => forbidden.has(argument) || argument.startsWith('--inspect'))) {
      throw new Error('workspace_exec_inline_code_not_allowed')
    }
  }
  for (const argument of argv.slice(1)) {
    if (isAbsolute(argument) || win32.isAbsolute(argument) || /(^|[\\/])\.\.([\\/]|$)/.test(argument)) {
      throw new Error('workspace_exec_argument_path_rejected')
    }
    if (/=[A-Za-z]:[\\/]/.test(argument) || argument.includes('=/')) {
      throw new Error('workspace_exec_argument_path_rejected')
    }
  }
  return argv
}

function workspaceExecutionArgv(payload: Record<string, unknown>): { profile: WorkspaceExecutionProfile, argv: string[] } {
  const profile = workspaceExecutionProfile(payload.execution_profile)
  const command = typeof payload.command === 'string' ? payload.command : ''
  const hasCommand = command.trim().length > 0
  const hasArgv = Array.isArray(payload.argv) && payload.argv.length > 0
  if (hasCommand === hasArgv) throw new Error('workspace_exec_input_invalid')
  if (hasCommand) {
    if (profile !== 'full.workspace') throw new Error('workspace_exec_shell_not_allowed')
    if (command.length > 65_536 || command.includes('\u0000')) throw new Error('workspace_exec_command_invalid')
    return {
      profile,
      argv: process.platform === 'win32'
        ? ['cmd.exe', '/d', '/s', '/c', command]
        : ['/bin/sh', '-lc', command],
    }
  }
  return { profile, argv: validateExecArgv(payload.argv, profile) }
}

async function validateWorkspaceExecutable(root: string, cwd: string, argv: string[]): Promise<void> {
  const program = argv[0].replaceAll('\\', '/')
  if (!PROJECT_VENV_PYTHON.test(program)) return

  const [venvDirectory] = program.split('/')
  const venvLexical = resolve(cwd, venvDirectory)
  if (!within(root, venvLexical) || !within(cwd, venvLexical)) throw new Error('workspace_exec_not_allowed')
  const venvRoot = await realpath(venvLexical).catch(() => { throw new Error('workspace_venv_unavailable') })
  if (!within(root, venvRoot) || !within(cwd, venvRoot)) throw new Error('workspace_symlink_escape')
  const config = await stat(join(venvRoot, 'pyvenv.cfg')).catch(() => { throw new Error('workspace_venv_invalid') })
  if (!config.isFile()) throw new Error('workspace_venv_invalid')

  const executableLexical = resolve(cwd, program)
  if (!within(root, executableLexical) || !within(cwd, executableLexical)) throw new Error('workspace_exec_not_allowed')
  const executableParent = await realpath(dirname(executableLexical)).catch(() => { throw new Error('workspace_venv_unavailable') })
  if (!within(root, executableParent) || !within(cwd, executableParent)) throw new Error('workspace_symlink_escape')
  const executableInfo = await lstat(executableLexical).catch(() => { throw new Error('workspace_venv_unavailable') })
  if (!executableInfo.isFile() && !executableInfo.isSymbolicLink()) throw new Error('workspace_venv_invalid')
  if (executableInfo.isSymbolicLink()) {
    const target = await realpath(executableLexical).catch(() => { throw new Error('workspace_venv_unavailable') })
    if (!/^python(?:3(?:\.\d+)*)?(?:\.exe)?$/i.test(basename(target))) {
      throw new Error('workspace_venv_invalid')
    }
  }
}

function minimalProcessEnv(cwd = '', nativeGit = false): NodeJS.ProcessEnv {
  const allowed = [
    'LANG', 'LC_ALL', 'PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'WINDIR',
  ]
  const env: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' }
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  const hostHome = process.env.HOME ?? process.env.USERPROFILE
  const effectiveHome = nativeGit ? hostHome : cwd
  if (effectiveHome) {
    env.HOME = effectiveHome
    env.USERPROFILE = effectiveHome
  }
  if (nativeGit && process.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = process.env.SSH_AUTH_SOCK
  if (nativeGit) {
    env.GIT_CONFIG_COUNT = '2'
    env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
    env.GIT_CONFIG_VALUE_0 = process.platform === 'win32' ? 'NUL' : '/dev/null'
    env.GIT_CONFIG_KEY_1 = 'core.fsmonitor'
    env.GIT_CONFIG_VALUE_1 = 'false'
  }
  return env
}

async function killProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolveKill) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        env: minimalProcessEnv(), shell: false, stdio: 'ignore', windowsHide: true,
      })
      killer.once('close', () => resolveKill())
      killer.once('error', () => { child.kill(); resolveKill() })
    })
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

async function executeProcess(
  cwd: string,
  argv: string[],
  timeoutMs: number,
  nativeGit = false,
): Promise<Record<string, unknown>> {
  const startedAt = performance.now()
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd,
      env: minimalProcessEnv(cwd, nativeGit),
      detached: process.platform !== 'win32',
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    const outputState = { bytes: 0, truncated: false }
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      void killProcessTree(child)
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => appendBounded(stdout, chunk, outputState))
    child.stderr.on('data', (chunk: Buffer) => appendBounded(stderr, chunk, outputState))
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectProcess(new Error((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'workspace_exec_executable_unavailable'
        : `workspace_exec_failed:${error.message}`))
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolveProcess({
        exit_code: typeof code === 'number' ? code : -1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        truncated: outputState.truncated,
        elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)),
        timed_out: timedOut,
        ...(signal ? { signal } : {}),
      })
    })
  })
}

type WorkspaceExecutionStatus = 'running' | 'success' | 'failed' | 'timed_out' | 'interrupted'

interface WorkspaceExecution {
  executionId: string
  runtimeId: string
  workspaceId: string
  executionProfile: WorkspaceExecutionProfile
  cwd: string
  argv: string[]
  status: WorkspaceExecutionStatus
  startedAt: number
  completedAt?: number
  child: ChildProcess
  stdout: Buffer[]
  stderr: Buffer[]
  outputState: { bytes: number, truncated: boolean }
  exitCode?: number
  signal?: string
  timer: NodeJS.Timeout
  interrupted: boolean
}

const workspaceExecutions = new Map<string, WorkspaceExecution>()

function cleanupExecutions(now = Date.now()): void {
  for (const [executionId, execution] of workspaceExecutions) {
    if (execution.completedAt !== undefined && now - execution.completedAt > WORKSPACE_EXEC_RETENTION_MS) {
      workspaceExecutions.delete(executionId)
    }
  }
}

function executionSnapshot(execution: WorkspaceExecution, includeOutput = false): Record<string, unknown> {
  return {
    execution_id: execution.executionId,
    status: execution.status,
    execution_profile: execution.executionProfile,
    cwd: execution.cwd,
    argv: execution.argv,
    started_at_ms: execution.startedAt,
    ...(execution.completedAt !== undefined ? {
      completed_at_ms: execution.completedAt,
      elapsed_ms: Math.max(0, execution.completedAt - execution.startedAt),
    } : { elapsed_ms: Math.max(0, Date.now() - execution.startedAt) }),
    ...(execution.exitCode !== undefined ? { exit_code: execution.exitCode } : {}),
    ...(execution.signal ? { signal: execution.signal } : {}),
    truncated: execution.outputState.truncated,
    ...(includeOutput ? {
      stdout: Buffer.concat(execution.stdout).toString('utf8'),
      stderr: Buffer.concat(execution.stderr).toString('utf8'),
    } : {}),
  }
}

function requireExecution(payload: Record<string, unknown>): WorkspaceExecution {
  cleanupExecutions()
  const executionId = required(payload, 'execution_id')
  const execution = workspaceExecutions.get(executionId)
  if (execution === undefined) throw new Error('workspace_execution_not_found')
  if (execution.runtimeId !== required(payload, 'runtime_id') || execution.workspaceId !== required(payload, 'workspace_id')) {
    throw new Error('workspace_execution_not_found')
  }
  return execution
}

function startWorkspaceExecution(
  runtimeId: string,
  workspaceId: string,
  executionProfile: WorkspaceExecutionProfile,
  cwdPath: string,
  cwdDisplay: string,
  argv: string[],
  timeoutMs: number,
): WorkspaceExecution {
  cleanupExecutions()
  const running = [...workspaceExecutions.values()].filter((item) => item.status === 'running').length
  if (running >= WORKSPACE_EXEC_MAX_CONCURRENT) throw new Error('workspace_exec_capacity_exceeded')
  const executionId = `wexec_${randomUUID()}`
  const child = spawn(argv[0], argv.slice(1), {
    cwd: cwdPath,
    env: minimalProcessEnv(cwdPath),
    detached: process.platform !== 'win32',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const execution: WorkspaceExecution = {
    executionId,
    runtimeId,
    workspaceId,
    executionProfile,
    cwd: cwdDisplay,
    argv,
    status: 'running',
    startedAt: Date.now(),
    child,
    stdout: [],
    stderr: [],
    outputState: { bytes: 0, truncated: false },
    timer: setTimeout(() => {
      if (execution.status !== 'running') return
      execution.status = 'timed_out'
      void killProcessTree(child)
    }, timeoutMs),
    interrupted: false,
  }
  workspaceExecutions.set(executionId, execution)
  child.stdout?.on('data', (chunk: Buffer) => appendBounded(execution.stdout, chunk, execution.outputState))
  child.stderr?.on('data', (chunk: Buffer) => appendBounded(execution.stderr, chunk, execution.outputState))
  child.once('error', (error) => {
    clearTimeout(execution.timer)
    execution.status = 'failed'
    execution.completedAt = Date.now()
    execution.exitCode = -1
    appendBounded(execution.stderr, Buffer.from(
      (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'workspace_exec_executable_unavailable'
        : `workspace_exec_failed:${error.message}`,
    ), execution.outputState)
  })
  child.once('close', (code, signal) => {
    clearTimeout(execution.timer)
    if (execution.status === 'running') {
      execution.status = code === 0 ? 'success' : 'failed'
    } else if (execution.interrupted) {
      execution.status = 'interrupted'
    }
    execution.completedAt = Date.now()
    execution.exitCode = typeof code === 'number' ? code : -1
    if (signal) execution.signal = signal
  })
  return execution
}

async function gitRead(root: string, args: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  return executeProcess(root, ['git', ...args], timeoutMs)
}

async function successfulProcess(cwd: string, argv: string[], timeoutMs: number): Promise<Record<string, unknown>> {
  // Only native Git operations get the host Git identity/SSH agent. Generic
  // workspace.exec stays on the minimal workspace-local environment.
  const result = await executeProcess(cwd, argv, timeoutMs, argv[0].toLowerCase().replace(/\.exe$/i, '') === 'git')
  if (result.timed_out === true) throw new Error('workspace_exec_timeout')
  if (result.exit_code !== 0) {
    throw new Error(`workspace_command_failed:exit_${result.exit_code}`)
  }
  return result
}

function safeGitToken(value: unknown, key: string, fallback = ''): string {
  const token = String(value ?? fallback).trim() || fallback
  if (token.length === 0 || token.length > 255 || token.startsWith('-') || !/^[A-Za-z0-9._/@:+-]+$/.test(token)) {
    throw new Error(`${key}_invalid`)
  }
  return token
}

function safeGitRemote(value: unknown): string {
  const remote = String(value ?? 'origin').trim() || 'origin'
  if (remote.length > 100 || remote.startsWith('-') || !/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error('remote_invalid')
  return remote
}

function safeGitPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) throw new Error('paths_invalid')
  return value.map((item) => normalizedRelativePath(item))
}

async function currentGitCommit(root: string, timeoutMs: number): Promise<string> {
  const result = await successfulProcess(root, ['git', 'rev-parse', 'HEAD'], timeoutMs)
  return String(result.stdout ?? '').trim()
}

function parseGitStatus(stdout: string): Record<string, unknown> {
  const lines = stdout.split(/\r?\n/).filter(Boolean)
  const branchLine = lines.find((line) => line.startsWith('# branch.head '))
  const upstreamLine = lines.find((line) => line.startsWith('# branch.upstream '))
  const aheadBehind = lines.find((line) => line.startsWith('# branch.ab '))
  const match = aheadBehind?.match(/^# branch\.ab \+(\d+) -(\d+)$/)
  const changes = lines.filter((line) => !line.startsWith('# '))
  return {
    branch: branchLine?.slice('# branch.head '.length) ?? '',
    upstream: upstreamLine?.slice('# branch.upstream '.length) ?? '',
    ahead: match ? Number(match[1]) : 0,
    behind: match ? Number(match[2]) : 0,
    dirty: changes.length > 0,
    changes,
  }
}

async function gitStatus(root: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const result = await successfulProcess(root, ['git', 'status', '--porcelain=v2', '--branch'], timeoutMs)
  return { ...parseGitStatus(String(result.stdout ?? '')), elapsed_ms: result.elapsed_ms }
}

async function resolveGitRepository(
  registry: WorkspaceControlRegistry,
  payload: Record<string, unknown>,
  mode: 'read' | 'exec',
  timeoutMs: number,
): Promise<{ workspaceRoot: string, repositoryRoot: string, repoPath: string }> {
  const target = await workspaceTarget(registry, payload, mode, 'repo_path')
  const info = await stat(target.target)
  if (!info.isDirectory()) throw new Error('workspace_git_repository_required')
  const result = await successfulProcess(target.target, ['git', 'rev-parse', '--show-toplevel'], timeoutMs)
  const repositoryRoot = await realpath(String(result.stdout ?? '').trim())
  if (!within(target.root, repositoryRoot)) throw new Error('workspace_git_root_outside_boundary')
  if (relative(target.target, repositoryRoot) !== '') {
    throw new Error('workspace_git_repo_path_must_be_root')
  }
  return {
    workspaceRoot: target.root,
    repositoryRoot,
    repoPath: target.relativePath,
  }
}

// --- Structured clone failure diagnostics (XIOT-BUG-0037) -------------------
// Failures keep the legacy `workspace_command_failed:exit_<code>` message so
// the wire contract is unchanged; the classification and bounded, secret-safe
// excerpts ride along on `error.details` for the control surface to relay.

const CLONE_EXCERPT_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g
// Any URI whose authority carries userinfo (e.g. `https://user:pass@host/` or
// `https://<token>@host/`) may embed credentials; the whole line is dropped.
// SCP-style remotes such as `git@github.com:xiotbox/repo.git` have no scheme
// authority and are kept.
const CLONE_EXCERPT_CREDENTIAL_URL = /[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/\s]*)/

export function boundedExcerpt(value: unknown, max: number): string {
  const safeLines = String(value ?? '')
    .replace(CLONE_EXCERPT_CONTROL_CHARS, '')
    .split(/\r?\n/)
    .filter((line) => {
      const authority = CLONE_EXCERPT_CREDENTIAL_URL.exec(line)
      return authority === null || !authority[1].includes('@')
    })
  const text = safeLines.join('\n')
  if (max <= 0) return ''
  return text.length > max ? text.slice(-max) : text
}

// Classification is deliberately conservative and order-sensitive. Where
// GitHub itself makes "private repository does not exist" and "caller cannot
// access it" indistinguishable, both stay in the same ambiguous class.
export function classifyCloneFailure(text: string): string {
  const combined = String(text ?? '')
  if (/Repository not found|access denied|could not read Username|Authentication failed for|Permission to .* denied/i.test(combined)) {
    return 'REPOSITORY_NOT_FOUND_OR_ACCESS_DENIED'
  }
  if (/Permission denied \(publickey|Host key verification failed|ssh_exchange_identification|Connection.*closed by remote host.*port 22/i.test(combined)) {
    return 'SSH_AUTH_FAILED'
  }
  if (/Could not resolve host|Failed to connect|Connection timed out|Network is unreachable/i.test(combined)) {
    return 'NETWORK_UNREACHABLE'
  }
  if (/Remote branch .* not found in upstream|not found in upstream origin/i.test(combined)) {
    return 'DEFAULT_BRANCH_MISSING'
  }
  return 'GIT_CLONE_FAILED'
}

export interface CloneFailureContext {
  repo: string
  destination: string
  branch: string
}

export function cloneFailureError(
  errorClass: string,
  exitCode: number,
  stderrText: string,
  stdoutText: string,
  context: CloneFailureContext,
): Error & { details: Record<string, unknown> } {
  const error = new Error(`workspace_command_failed:exit_${exitCode}`) as Error & { details: Record<string, unknown> }
  error.details = {
    error_code: 'workspace_git_clone_failed',
    error_class: errorClass,
    exit_code: exitCode,
    repo: context.repo,
    destination: context.destination,
    branch: context.branch,
    stderr_excerpt: boundedExcerpt(stderrText, 1200),
    stdout_excerpt: boundedExcerpt(stdoutText, 600),
  }
  return error
}

export async function executeWorkspaceControl(
  registry: WorkspaceControlRegistry,
  commandType: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (commandType === 'workspace.git.clone') {
    const timeoutMs = boundedInteger(payload.timeout_ms, 120_000, 1, WORKSPACE_EXEC_MAX_TIMEOUT_MS, 'workspace_exec_timeout_invalid')
    const { root } = await resolveWorkspace(registry, payload, 'exec')
    const repo = required(payload, 'repo').toLowerCase()
    const match = XIOTBOX_REPOSITORY.exec(repo)
    if (!match) throw new Error('workspace_git_clone_repo_invalid')
    const destination = normalizedRelativePath(payload.destination)
    if (destination !== match[1] || destination.includes('/')) throw new Error('workspace_git_clone_destination_invalid')
    const branch = safeGitToken(payload.branch, 'branch', 'main')
    const target = resolve(root, destination)
    if (!within(root, target)) throw new Error('workspace_path_rejected')
    try {
      await lstat(target)
      throw new Error('workspace_destination_exists')
    } catch (error) {
      if (String(error) === 'Error: workspace_destination_exists') throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const origin = `git@github.com:${repo}.git`
    try {
      const cloneResult = await executeProcess(root, ['git', 'clone', '--origin', 'origin', '--branch', branch, '--single-branch', '--', origin, destination], timeoutMs, true)
      if (cloneResult.timed_out === true) throw new Error('workspace_exec_timeout')
      if (cloneResult.exit_code !== 0) {
        throw cloneFailureError(
          classifyCloneFailure(`${String(cloneResult.stderr ?? '')}\n${String(cloneResult.stdout ?? '')}`),
          Number(cloneResult.exit_code),
          String(cloneResult.stderr ?? ''),
          String(cloneResult.stdout ?? ''),
          { repo, destination, branch },
        )
      }
      const repositoryRoot = await realpath(target)
      if (!within(root, repositoryRoot) || repositoryRoot !== target) throw new Error('workspace_git_clone_boundary_mismatch')
      const commitResult = await executeProcess(repositoryRoot, ['git', 'rev-parse', 'HEAD'], timeoutMs, true)
      if (commitResult.timed_out === true) throw new Error('workspace_exec_timeout')
      if (commitResult.exit_code !== 0) {
        const revParseText = `${String(commitResult.stderr ?? '')}\n${String(commitResult.stdout ?? '')}`
        if (/ambiguous argument/i.test(revParseText)) {
          throw cloneFailureError('EMPTY_REPOSITORY', Number(commitResult.exit_code), String(commitResult.stderr ?? ''), String(commitResult.stdout ?? ''), { repo, destination, branch })
        }
        throw new Error(`workspace_command_failed:exit_${Number(commitResult.exit_code)}`)
      }
      const commit = String(commitResult.stdout ?? '').trim()
      const confirmedOrigin = await successfulProcess(repositoryRoot, ['git', 'config', '--get', 'remote.origin.url'], timeoutMs)
      if (String(confirmedOrigin.stdout ?? '').trim() !== origin) throw new Error('workspace_git_clone_origin_mismatch')
      return { repo, destination, branch, commit, origin }
    } catch (error) {
      await rm(target, { recursive: true, force: true })
      throw error
    }
  }

  if (commandType === 'workspace.files.list') {
    const { target, relativePath } = await workspaceTarget(registry, payload, 'read')
    const info = await stat(target)
    if (!info.isDirectory()) throw new Error('workspace_directory_required')
    const limit = boundedInteger(payload.limit, 500, 1, WORKSPACE_CONTROL_MAX_ENTRIES, 'workspace_limit_invalid')
    const entries = await readdir(target, { withFileTypes: true })
    return {
      path: relativePath,
      truncated: entries.length > limit,
      entries: entries.slice(0, limit).map(entry => ({
        name: entry.name,
        path: relativePath === '.' ? entry.name : `${relativePath}/${entry.name}`,
        type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other',
      })),
    }
  }

  if (commandType === 'workspace.file.read') {
    const { target, relativePath } = await workspaceTarget(registry, payload, 'read')
    const current = await currentFile(target)
    return { path: relativePath, content: current.content.toString('utf8'), bytes: current.content.byteLength, sha256: current.sha256 }
  }

  if (commandType === 'workspace.file.read_range') {
    const { target, relativePath } = await workspaceTarget(registry, payload, 'read')
    const info = await stat(target)
    if (!info.isFile()) throw new Error('workspace_file_required')
    if (info.size > WORKSPACE_READ_RANGE_MAX_FILE_BYTES) throw new Error('workspace_file_too_large')
    const startLine = boundedInteger(payload.start_line, 1, 1, 10_000_000, 'start_line_invalid')
    const endLine = boundedInteger(payload.end_line, startLine + 199, startLine, startLine + 1_999, 'end_line_invalid')
    const content = await readFile(target)
    const lines = content.toString('utf8').split(/\r?\n/)
    const selected = lines.slice(startLine - 1, endLine)
    let ranged = selected.join('\n')
    let truncated = false
    if (Buffer.byteLength(ranged, 'utf8') > WORKSPACE_CONTROL_MAX_BYTES) {
      ranged = Buffer.from(ranged, 'utf8').subarray(0, WORKSPACE_CONTROL_MAX_BYTES).toString('utf8')
      truncated = true
    }
    return {
      path: relativePath,
      content: ranged,
      start_line: startLine,
      end_line: Math.min(endLine, lines.length),
      total_lines: lines.length,
      sha256: sha256(content),
      truncated,
    }
  }

  if (commandType === 'workspace.file.write') {
    const { target, relativePath } = await workspaceTarget(registry, payload, 'write')
    const content = Buffer.from(String(payload.content ?? ''), 'utf8')
    if (content.byteLength > WORKSPACE_CONTROL_MAX_BYTES) throw new Error('workspace_file_too_large')
    const expected = String(payload.expected_sha256 ?? '').trim().toLowerCase()
    let existing: { content: Buffer, sha256: string } | undefined
    try {
      existing = await currentFile(target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && String(error) !== 'Error: workspace_path_unavailable') throw error
    }
    if (existing !== undefined && expected.length === 0) throw new Error('expected_sha256_required')
    if (existing !== undefined && existing.sha256 !== expected) throw new Error('workspace_file_changed')
    if (existing === undefined && expected.length > 0) throw new Error('workspace_file_missing')
    if (payload.create_parents === true) await mkdir(dirname(target), { recursive: true })
    await atomicWrite(target, content)
    return { path: relativePath, bytes: content.byteLength, sha256: sha256(content), created: existing === undefined }
  }

  if (commandType === 'workspace.file.patch') {
    const { target, relativePath } = await workspaceTarget(registry, payload, 'write')
    const expected = required(payload, 'expected_sha256').toLowerCase()
    const oldText = requiredRaw(payload, 'old_text')
    const newText = String(payload.new_text ?? '')
    const newlineMode = parseNewlineMode(payload.newline_mode)
    const existing = await currentFile(target)
    if (existing.sha256 !== expected) throw new Error('workspace_file_changed')
    const source = existing.content.toString('utf8')
    const matches = source.split(oldText).length - 1
    if (newlineMode === 'preserve' && matches === 0) {
      // Newline-aware fallback: match on the normalized form and write the
      // replacement in the target file's own newline convention. CAS has
      // already been validated above against the original bytes.
      const patched = applyNewlineAwarePatch(source, oldText, newText, { replaceAll: payload.replace_all === true })
      const updated = Buffer.from(patched.text, 'utf8')
      if (updated.byteLength > WORKSPACE_CONTROL_MAX_BYTES) throw new Error('workspace_file_too_large')
      await atomicWrite(target, updated)
      return {
        path: relativePath,
        old_sha256: existing.sha256,
        new_sha256: sha256(updated),
        bytes: updated.byteLength,
        replaced: patched.replaced,
      }
    }
    if (matches === 0) {
      // Read-only diagnostic: when the exact match fails but the normalized
      // form would have matched, classify the failure as a newline mismatch so
      // callers can fix the request instead of re-reading the file. No write
      // ever happens on this path; CAS has already been validated above.
      const fileNewline = detectNewlineStyle(source)
      if (fileNewline !== 'none') {
        const normalizedCount = source.replaceAll('\r\n', '\n').split(oldText.replaceAll('\r\n', '\n')).length - 1
        if (normalizedCount > 0) {
          throwPatchError('workspace_patch_old_text_not_found', {
            reason: 'newline_mismatch',
            file_newline: fileNewline,
            request_newline: detectNewlineStyle(oldText),
            normalized_match_count: normalizedCount,
            error_code: 'workspace_patch_old_text_not_found',
          })
        }
      }
      throw new Error('workspace_patch_old_text_not_found')
    }
    if (payload.replace_all !== true && matches !== 1) throw new Error('workspace_patch_ambiguous')
    const updatedText = payload.replace_all === true ? source.split(oldText).join(newText) : source.replace(oldText, newText)
    const updated = Buffer.from(updatedText, 'utf8')
    if (updated.byteLength > WORKSPACE_CONTROL_MAX_BYTES) throw new Error('workspace_file_too_large')
    await atomicWrite(target, updated)
    return {
      path: relativePath,
      old_sha256: existing.sha256,
      new_sha256: sha256(updated),
      bytes: updated.byteLength,
      replaced: payload.replace_all === true ? matches : 1,
    }
  }

  if (commandType === 'workspace.file.delete') {
    const { target, relativePath } = await workspaceTarget(registry, payload, 'write')
    const expected = required(payload, 'expected_sha256').toLowerCase()
    const existing = await currentFile(target)
    if (existing.sha256 !== expected) throw new Error('workspace_file_changed')
    await rm(target)
    return { path: relativePath, deleted: true, previous_sha256: existing.sha256 }
  }

  if (commandType === 'workspace.stat') {
    const { root } = await resolveWorkspace(registry, payload, 'read')
    const requested = normalizedRelativePath(payload.path)
    const lexical = resolve(root, requested)
    if (!within(root, lexical)) throw new Error('workspace_path_rejected')
    const info = await lstat(lexical).catch(() => { throw new Error('workspace_path_unavailable') })
    if (info.isSymbolicLink()) {
      const resolved = await realpath(lexical).catch(() => { throw new Error('workspace_path_unavailable') })
      if (!within(root, resolved)) throw new Error('workspace_symlink_escape')
    }
    const result: Record<string, unknown> = {
      path: relative(root, lexical).replaceAll('\\', '/') || '.',
      type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
      size: info.size,
      mtime_ms: Math.round(info.mtimeMs),
    }
    if (info.isFile() && info.size <= WORKSPACE_CONTROL_MAX_BYTES) result.sha256 = (await currentFile(lexical)).sha256
    return result
  }

  if (commandType === 'workspace.mkdir') {
    const { target, relativePath } = await workspaceTarget(registry, payload, 'write')
    await mkdir(target, { recursive: payload.recursive === true })
    return { path: relativePath, created: true, recursive: payload.recursive === true }
  }

  if (commandType === 'workspace.move') {
    const source = await workspaceTarget(registry, payload, 'write', 'source_path')
    const destination = await workspaceTarget(registry, { ...payload, path: payload.destination_path }, 'write')
    if (source.root !== destination.root) throw new Error('workspace_boundary_mismatch')
    try {
      await lstat(destination.target)
      throw new Error('workspace_destination_exists')
    } catch (error) {
      if (String(error) === 'Error: workspace_destination_exists') throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(source.target, destination.target)
    return { source_path: source.relativePath, destination_path: destination.relativePath, moved: true }
  }

  if (commandType === 'workspace.copy') {
    const source = await workspaceTarget(registry, payload, 'read', 'source_path')
    const destination = await workspaceTarget(registry, { ...payload, path: payload.destination_path }, 'write')
    if (source.root !== destination.root) throw new Error('workspace_boundary_mismatch')
    const existing = await currentFile(source.target)
    if (payload.overwrite !== true) {
      try {
        await lstat(destination.target)
        throw new Error('workspace_destination_exists')
      } catch (error) {
        if (String(error) === 'Error: workspace_destination_exists') throw error
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    await copyFile(source.target, destination.target)
    return { source_path: source.relativePath, destination_path: destination.relativePath, bytes: existing.content.byteLength, sha256: existing.sha256, copied: true }
  }

  if (commandType === 'workspace.search') {
    const { target, relativePath } = await workspaceTarget(registry, payload, 'read')
    const query = required(payload, 'query')
    const caseSensitive = payload.case_sensitive === true
    const needle = caseSensitive ? query : query.toLowerCase()
    const maxResults = boundedInteger(payload.max_results, 100, 1, 500, 'workspace_search_limit_invalid')
    const matches: Array<Record<string, unknown>> = []
    let scannedFiles = 0
    let truncated = false
    const inspectFile = async (file: string, displayPath: string): Promise<void> => {
      const info = await stat(file)
      if (info.size > WORKSPACE_SEARCH_MAX_FILE_BYTES) return
      const content = await readFile(file, 'utf8')
      if (content.includes('\u0000')) return
      scannedFiles += 1
      const lines = content.split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const haystack = caseSensitive ? lines[index] : lines[index].toLowerCase()
        const column = haystack.indexOf(needle)
        if (column < 0) continue
        matches.push({ path: displayPath, line: index + 1, column: column + 1, text: lines[index].slice(0, 2_000) })
        if (matches.length >= maxResults) { truncated = true; return }
      }
    }
    const walk = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true })
      for (const entry of entries) {
        if (matches.length >= maxResults) { truncated = true; return }
        if (entry.isSymbolicLink()) continue
        const child = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (!SEARCH_IGNORED_DIRECTORIES.has(entry.name)) await walk(child)
        } else if (entry.isFile()) {
          await inspectFile(child, relative(target, child).replaceAll('\\', '/'))
        }
      }
    }
    const targetInfo = await stat(target)
    if (targetInfo.isDirectory()) await walk(target)
    else if (targetInfo.isFile()) await inspectFile(target, relativePath)
    else throw new Error('workspace_file_or_directory_required')
    return { path: relativePath, query, matches, count: matches.length, scanned_files: scannedFiles, truncated }
  }

  const scopedGitCommand = (
    commandType.startsWith('workspace.git.') || commandType.startsWith('workspace.worktree.')
  ) && commandType.endsWith('.scoped')
  const gitCommandType = scopedGitCommand ? commandType.slice(0, -'.scoped'.length) : commandType
  const requestedRepoPath = normalizedRelativePath(payload.repo_path)
  if (scopedGitCommand && requestedRepoPath === '.') throw new Error('workspace_git_repo_path_required')
  if (!scopedGitCommand && requestedRepoPath !== '.') {
    throw new Error('workspace_git_repo_path_requires_scoped_command')
  }

  if (gitCommandType === 'workspace.git.status' || gitCommandType === 'workspace.git.diff' || gitCommandType === 'workspace.git.log' || gitCommandType === 'workspace.git.show') {
    const timeoutMs = boundedInteger(payload.timeout_ms, 30_000, 1, WORKSPACE_EXEC_MAX_TIMEOUT_MS, 'workspace_exec_timeout_invalid')
    const { repositoryRoot, repoPath } = await resolveGitRepository(registry, payload, 'read', timeoutMs)
    if (gitCommandType === 'workspace.git.status') return { repo_path: repoPath, ...await gitStatus(repositoryRoot, timeoutMs) }
    if (gitCommandType === 'workspace.git.diff') {
      const args = ['diff', '--no-ext-diff', '--no-color']
      if (payload.staged === true) args.push('--cached')
      const path = String(payload.path ?? '').trim()
      if (path) args.push('--', normalizedRelativePath(path))
      return { repo_path: repoPath, ...await gitRead(repositoryRoot, args, timeoutMs) }
    }
    if (gitCommandType === 'workspace.git.show') {
      const commit = safeGitToken(payload.commit, 'commit', 'HEAD')
      const result = await successfulProcess(repositoryRoot, ['git', 'show', '--no-ext-diff', '--no-textconv', '--no-color', '--stat', '--format=%H%n%aI%n%an%n%s', commit], timeoutMs)
      return { repo_path: repoPath, commit, output: result.stdout, truncated: result.truncated, elapsed_ms: result.elapsed_ms }
    }
    const limit = boundedInteger(payload.limit, 20, 1, 100, 'workspace_git_log_limit_invalid')
    const result = await successfulProcess(repositoryRoot, ['git', 'log', `-${limit}`, '--format=%H%x09%aI%x09%an%x09%s'], timeoutMs)
    const commits = String(result.stdout ?? '').split(/\r?\n/).filter(Boolean).map((line) => {
      const [commit, authoredAt, author, ...subject] = line.split('\t')
      return { commit, authored_at: authoredAt, author, subject: subject.join('\t') }
    })
    return { repo_path: repoPath, commits, count: commits.length, truncated: result.truncated, elapsed_ms: result.elapsed_ms }
  }

  if (gitCommandType.startsWith('workspace.git.')) {
    const timeoutMs = boundedInteger(payload.timeout_ms, 120_000, 1, WORKSPACE_EXEC_MAX_TIMEOUT_MS, 'workspace_exec_timeout_invalid')
    const { repositoryRoot, repoPath } = await resolveGitRepository(registry, payload, 'exec', timeoutMs)
    if (gitCommandType === 'workspace.git.sync') {
      const remote = safeGitRemote(payload.remote)
      await successfulProcess(repositoryRoot, ['git', 'remote', 'get-url', remote], timeoutMs)
      const expectedCommit = safeGitToken(payload.expected_commit, 'expected_commit')
      const beforeCommit = await currentGitCommit(repositoryRoot, timeoutMs)
      if (beforeCommit !== expectedCommit) throw new Error('workspace_git_commit_changed')
      const tracked = await successfulProcess(
        repositoryRoot, ['git', 'status', '--porcelain', '--untracked-files=no'], timeoutMs,
      )
      if (String(tracked.stdout ?? '').trim()) throw new Error('workspace_git_sync_tracked_changes')
      const branchResult = await successfulProcess(repositoryRoot, ['git', 'branch', '--show-current'], timeoutMs)
      const branch = safeGitToken(branchResult.stdout, 'branch')
      const upstreamResult = await successfulProcess(
        repositoryRoot, ['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], timeoutMs,
      )
      const upstream = safeGitToken(upstreamResult.stdout, 'upstream')
      if (!upstream.startsWith(`${remote}/`)) throw new Error('workspace_git_upstream_remote_mismatch')
      await successfulProcess(repositoryRoot, ['git', 'fetch', '--prune', remote], timeoutMs)
      const postFetchCommit = await currentGitCommit(repositoryRoot, timeoutMs)
      if (postFetchCommit !== expectedCommit) throw new Error('workspace_git_commit_changed')
      const postFetchTracked = await successfulProcess(
        repositoryRoot, ['git', 'status', '--porcelain', '--untracked-files=no'], timeoutMs,
      )
      if (String(postFetchTracked.stdout ?? '').trim()) throw new Error('workspace_git_sync_tracked_changes')
      await successfulProcess(repositoryRoot, ['git', 'merge', '--ff-only', '@{u}'], timeoutMs)
      const afterCommit = await currentGitCommit(repositoryRoot, timeoutMs)
      return {
        repo_path: repoPath,
        remote,
        branch,
        upstream,
        before_commit: beforeCommit,
        after_commit: afterCommit,
        updated: beforeCommit !== afterCommit,
        status: await gitStatus(repositoryRoot, timeoutMs),
      }
    }
    if (gitCommandType === 'workspace.git.add') {
      const paths = safeGitPaths(payload.paths)
      await successfulProcess(repositoryRoot, ['git', 'add', '--', ...paths], timeoutMs)
      return { repo_path: repoPath, added: paths, status: await gitStatus(repositoryRoot, timeoutMs) }
    }
    if (gitCommandType === 'workspace.git.commit') {
      const message = required(payload, 'message')
      if (message.length > 10_000) throw new Error('message_too_long')
      const before = await gitStatus(repositoryRoot, timeoutMs)
      const result = await successfulProcess(repositoryRoot, ['git', 'commit', '-m', message], timeoutMs)
      const commit = await currentGitCommit(repositoryRoot, timeoutMs)
      return { repo_path: repoPath, commit, output: result.stdout, before, status: await gitStatus(repositoryRoot, timeoutMs) }
    }
    if (gitCommandType === 'workspace.git.branch') {
      const action = String(payload.action ?? 'list').trim().toLowerCase()
      if (action === 'list') {
        const result = await successfulProcess(repositoryRoot, ['git', 'branch', '--format=%(refname:short)%09%(HEAD)'], timeoutMs)
        const branches = String(result.stdout ?? '').split(/\r?\n/).filter(Boolean).map((line) => {
          const [name, head] = line.split('\t')
          return { name, current: head === '*' }
        })
        return { repo_path: repoPath, branches }
      }
      if (action !== 'create') throw new Error('workspace_git_branch_action_invalid')
      const branch = safeGitToken(payload.branch, 'branch')
      const startPoint = safeGitToken(payload.start_point, 'start_point', 'HEAD')
      await successfulProcess(repositoryRoot, ['git', 'branch', branch, startPoint], timeoutMs)
      return { repo_path: repoPath, branch, start_point: startPoint, created: true }
    }
    if (gitCommandType === 'workspace.git.switch') {
      const branch = safeGitToken(payload.branch, 'branch')
      const args = ['git', 'switch']
      if (payload.create === true) {
        args.push('-c', branch, safeGitToken(payload.start_point, 'start_point', 'HEAD'))
      } else {
        args.push(branch)
      }
      await successfulProcess(repositoryRoot, args, timeoutMs)
      return { repo_path: repoPath, branch, created: payload.create === true, status: await gitStatus(repositoryRoot, timeoutMs) }
    }
    if (gitCommandType === 'workspace.git.push') {
      const remote = safeGitRemote(payload.remote)
      await successfulProcess(repositoryRoot, ['git', 'remote', 'get-url', remote], timeoutMs)
      const expectedCommit = safeGitToken(payload.expected_commit, 'expected_commit')
      const actualCommit = await currentGitCommit(repositoryRoot, timeoutMs)
      if (actualCommit !== expectedCommit) throw new Error('workspace_git_commit_changed')
      let branch = String(payload.branch ?? '').trim()
      if (!branch) {
        const current = await successfulProcess(repositoryRoot, ['git', 'branch', '--show-current'], timeoutMs)
        branch = safeGitToken(current.stdout, 'branch')
      } else branch = safeGitToken(branch, 'branch')
      const args = ['git', 'push']
      if (payload.set_upstream === true) args.push('--set-upstream')
      args.push(remote, branch)
      await successfulProcess(repositoryRoot, args, timeoutMs)
      return {
        repo_path: repoPath,
        remote,
        branch,
        commit: actualCommit,
        status: await gitStatus(repositoryRoot, timeoutMs),
      }
    }
    throw new Error('workspace_control_command_unsupported')
  }

  if (gitCommandType.startsWith('workspace.worktree.')) {
    const mode = gitCommandType === 'workspace.worktree.list' || gitCommandType === 'workspace.worktree.status' ? 'read' : 'exec'
    const timeoutMs = boundedInteger(payload.timeout_ms, 120_000, 1, WORKSPACE_EXEC_MAX_TIMEOUT_MS, 'workspace_exec_timeout_invalid')
    const { workspaceRoot, repositoryRoot, repoPath } = await resolveGitRepository(registry, payload, mode, timeoutMs)
    if (gitCommandType === 'workspace.worktree.list') {
      const result = await successfulProcess(repositoryRoot, ['git', 'worktree', 'list', '--porcelain'], timeoutMs)
      const records = String(result.stdout ?? '').trim().split(/\r?\n\r?\n/).filter(Boolean)
      let hiddenExternal = 0
      const worktrees: Array<Record<string, unknown>> = []
      for (const record of records) {
        const lines = record.split(/\r?\n/)
        const rawPath = lines.find((line) => line.startsWith('worktree '))?.slice(9) ?? ''
        const canonical = await realpath(rawPath).catch(() => '')
        if (!canonical || !within(workspaceRoot, canonical)) { hiddenExternal += 1; continue }
        worktrees.push({
          path: relative(workspaceRoot, canonical).replaceAll('\\', '/') || '.',
          commit: lines.find((line) => line.startsWith('HEAD '))?.slice(5) ?? '',
          branch: (lines.find((line) => line.startsWith('branch '))?.slice(7) ?? '').replace(/^refs\/heads\//, ''),
          detached: lines.includes('detached'),
          locked: lines.some((line) => line.startsWith('locked')),
        })
      }
      return { repo_path: repoPath, worktrees, count: worktrees.length, hidden_external_count: hiddenExternal }
    }
    if (gitCommandType === 'workspace.worktree.create') {
      const destination = await workspaceTarget(registry, { ...payload, path: payload.path, create_parents: true }, 'exec')
      const branch = safeGitToken(payload.branch, 'branch')
      const startPoint = safeGitToken(payload.start_point, 'start_point', 'HEAD')
      const args = ['git', 'worktree', 'add']
      if (payload.create_branch !== false) args.push('-b', branch)
      args.push(destination.target, payload.create_branch !== false ? startPoint : branch)
      await mkdir(dirname(destination.target), { recursive: true })
      await successfulProcess(repositoryRoot, args, timeoutMs)
      return { repo_path: repoPath, path: destination.relativePath, branch, commit: await currentGitCommit(destination.target, timeoutMs), created: true }
    }
    const target = await workspaceTarget(registry, { ...payload, path: payload.path }, mode)
    if (target.relativePath === '.') throw new Error('workspace_worktree_main_rejected')
    if (gitCommandType === 'workspace.worktree.remove') {
      if (payload.force === true) throw new Error('workspace_worktree_force_not_allowed')
      const args = ['git', 'worktree', 'remove', target.target]
      await successfulProcess(repositoryRoot, args, timeoutMs)
      return { repo_path: repoPath, path: target.relativePath, removed: true, forced: false }
    }
    if (gitCommandType === 'workspace.worktree.status') {
      return { repo_path: repoPath, path: target.relativePath, commit: await currentGitCommit(target.target, timeoutMs), status: await gitStatus(target.target, timeoutMs) }
    }
    throw new Error('workspace_control_command_unsupported')
  }

  if (commandType === 'workspace.exec') {
    const target = await workspaceTarget(registry, { ...payload, path: payload.cwd ?? '.' }, 'exec')
    const info = await stat(target.target)
    if (!info.isDirectory()) throw new Error('workspace_directory_required')
    const { profile, argv } = workspaceExecutionArgv(payload)
    await validateWorkspaceExecutable(target.root, target.target, argv)
    const timeoutMs = boundedInteger(payload.timeout_ms, 120_000, 1, WORKSPACE_EXEC_MAX_TIMEOUT_MS, 'workspace_exec_timeout_invalid')
    return { ...(await executeProcess(target.target, argv, timeoutMs)), execution_profile: profile }
  }

  if (commandType === 'workspace.exec.start') {
    const target = await workspaceTarget(registry, { ...payload, path: payload.cwd ?? '.' }, 'exec')
    const info = await stat(target.target)
    if (!info.isDirectory()) throw new Error('workspace_directory_required')
    const { profile, argv } = workspaceExecutionArgv(payload)
    await validateWorkspaceExecutable(target.root, target.target, argv)
    const timeoutMs = boundedInteger(payload.timeout_ms, 120_000, 1, WORKSPACE_EXEC_MAX_TIMEOUT_MS, 'workspace_exec_timeout_invalid')
    const execution = startWorkspaceExecution(
      required(payload, 'runtime_id'), required(payload, 'workspace_id'), profile,
      target.target, target.relativePath, argv, timeoutMs,
    )
    return executionSnapshot(execution)
  }

  if (commandType === 'workspace.exec.status' || commandType === 'workspace.exec.output' || commandType === 'workspace.exec.interrupt') {
    await resolveWorkspace(registry, payload, 'exec')
    const execution = requireExecution(payload)
    if (commandType === 'workspace.exec.status') return executionSnapshot(execution)
    if (commandType === 'workspace.exec.output') return executionSnapshot(execution, true)
    if (execution.status !== 'running') return { ...executionSnapshot(execution), interrupt_requested: false }
    execution.interrupted = true
    execution.status = 'interrupted'
    execution.completedAt = Date.now()
    await killProcessTree(execution.child)
    return { ...executionSnapshot(execution), interrupt_requested: true }
  }

  throw new Error('workspace_control_command_unsupported')
}
