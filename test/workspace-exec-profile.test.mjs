import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { executeWorkspaceControl } from '../dist/src/workspace-control.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'openclaw-xiot-workspace-exec-'));
  const registry = {
    async resolve(runtimeId, workspaceId) {
      if (runtimeId !== 'openclaw-runtime' || workspaceId !== 'workspace') return undefined;
      return { localPath: root, readable: true, writable: true, executable: true };
    },
  };
  return {
    root,
    registry,
    base: { runtime_id: 'openclaw-runtime', workspace_id: 'workspace', cwd: '.', timeout_ms: 2000 },
  };
}

test('safe workspace exec rejects inline code and unsafe git subcommands', async () => {
  const { root, registry, base } = await fixture();
  try {
    for (const [argv, error] of [
      [['node', '-e', "console.log('unsafe')"], /workspace_exec_inline_code_not_allowed/],
      [['python3', '-c', "print('unsafe')"], /workspace_exec_inline_code_not_allowed/],
      [['git', 'checkout', 'main'], /workspace_git_command_not_allowed/],
    ]) {
      await assert.rejects(
        executeWorkspaceControl(registry, 'workspace.exec', { ...base, execution_profile: 'safe', argv }),
        error,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('full.workspace keeps arbitrary argv separate from safe', async () => {
  const { root, registry, base } = await fixture();
  try {
    const result = await executeWorkspaceControl(registry, 'workspace.exec', {
      ...base,
      execution_profile: 'full.workspace',
      argv: ['node', '-e', "process.stdout.write('ok')"],
    });
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, 'ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
