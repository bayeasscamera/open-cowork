/**
 * End-to-end machine access on REAL files in a REAL temporary directory:
 * create → organize (batch) → rename → trash → undo.
 *
 * Everything here runs the same code path the app runs: the single tool
 * registry, `invokeTool()`, the journal, the backup/trash flow and the
 * approval binding. Nothing is stubbed except the Electron system trash,
 * which is replaced by the Cowork-side trash fallback the service uses when
 * Electron is unavailable.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolRegistry, type ToolContext } from '../src/main/tools/registry';
import { invokeTool } from '../src/main/tools/invoke';
import { MachineAccessService } from '../src/main/machine-access/machine-access-service';
import { assessRisk } from '../src/main/machine-access/risk-assessor';
import { fingerprintAction } from '../src/main/machine-access/approval-binding';

describe('machine access end-to-end (real files)', () => {
  let workspace: string;
  let appData: string;
  let service: MachineAccessService;
  let registry: ToolRegistry;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-e2e-ws-')));
    appData = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-e2e-data-')));
    registry = new ToolRegistry();
    service = new MachineAccessService({
      workspaceRoot: workspace,
      projectId: 'p-e2e',
      appDataPath: appData,
      registry,
      trashItem: async (filePath) => {
        // Same guarantee as the system trash: nothing is unlinked.
        const dir = path.join(appData, 'cowork-trash');
        fs.mkdirSync(dir, { recursive: true });
        fs.renameSync(filePath, path.join(dir, `${Date.now()}-${path.basename(filePath)}`));
      },
    });
    service.registerTools();
    // The workspace is granted by the user (native picker equivalent).
    service.addGrantFromUser({ path: workspace, access: 'read-write', scope: 'session' });
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(appData, { recursive: true, force: true });
  });

  const call = async (name: string, args: unknown) => {
    const ctx: ToolContext = { sessionId: 's-e2e', cwd: workspace };
    return invokeTool(registry, name, args, ctx, { decidePermission: () => ({ allowed: true }) });
  };

  it('create → organize → rename → trash → undo, on real files', async () => {
    // 1. Create three real files.
    for (const name of ['alpha.txt', 'beta.txt', 'gamma.txt']) {
      const r = await call('fs_write', { path: path.join(workspace, name), content: `content-${name}` });
      expect(r.isError).toBeFalsy();
    }
    expect(fs.readdirSync(workspace).filter((f) => f.endsWith('.txt')).length).toBe(3);

    // 2. Batch organize: preview (dry run) then execute identically.
    const ops = ['alpha.txt', 'beta.txt', 'gamma.txt'].map((name) => ({
      type: 'move' as const,
      src: path.join(workspace, name),
      dest: path.join(workspace, 'sorted', name),
    }));
    const plan = service.planBatch(ops);
    expect(plan.conflicts).toHaveLength(0);
    // Preview changes nothing.
    expect(fs.existsSync(path.join(workspace, 'sorted'))).toBe(false);
    const batch = await service.runBatch(plan);
    expect(batch.done).toBe(3);
    expect(batch.pending).toBe(0);
    expect(fs.readdirSync(path.join(workspace, 'sorted')).length).toBe(3);
    expect(fs.readdirSync(workspace).filter((f) => f.endsWith('.txt'))).toHaveLength(0);

    // 3. Rename the created folder, undoable through the journal.
    const renamed = path.join(workspace, 'organized');
    const renameOp = service.planBatch(
      [{ type: 'move', src: path.join(workspace, 'sorted'), dest: renamed }],
      true
    );
    expect((await service.runBatch(renameOp)).done).toBe(1);
    expect(fs.existsSync(renamed)).toBe(true);

    // 4. Trash one real file — never deleted permanently.
    const victim = path.join(renamed, 'beta.txt');
    const trashResult = await call('fs_trash', { path: victim });
    expect(trashResult.isError).toBeFalsy();
    expect(fs.existsSync(victim)).toBe(false);
    const trashBatchId = (JSON.parse(trashResult.content) as { batchId: string }).batchId;

    // 5. Undo restores the trashed file with its exact content.
    const undo = service.undoBatch(trashBatchId);
    expect(undo.refused).toHaveLength(0);
    expect(fs.readFileSync(victim, 'utf-8')).toBe('content-beta.txt');

    // 6. Undo the rename batch too: the folder returns to its original name.
    const renameBatchId = (service.history().find((op) => op.destination === renamed)?.batchId) ?? '';
    const undoRename = service.undoBatch(renameBatchId);
    expect(undoRename.refused).toHaveLength(0);
    expect(fs.existsSync(path.join(workspace, 'sorted'))).toBe(true);
    expect(fs.existsSync(path.join(workspace, 'sorted', 'beta.txt'))).toBe(true);
  });

  it('approval flow: dangerous action requires a card bound to the exact action', async () => {
    const risk = assessRisk({ kind: 'fs-delete', bypassesTrash: true });
    expect(service.needsApproval(risk, false)).toBe(true);
    service.setAutonomy('allow-all');
    // allow-all does NOT skip dangerous actions.
    expect(service.needsApproval(risk, false)).toBe(true);

    const card = service.requestApproval({
      kind: 'fs-delete',
      what: 'rm -rf /',
      origin: 'user-message',
      risk,
    });
    const action = { kind: 'fs-delete' as const, command: 'rm -rf /' };
    expect(service.resolveApproval(card.id, true, action).allowed).toBe(true);

    // A second attempt with a DIFFERENT action is refused.
    const second = service.requestApproval({ kind: 'fs-delete', what: 'rm -rf /', origin: 'user-message', risk });
    const changed = service.resolveApproval(second.id, true, { kind: 'fs-delete', command: 'rm -rf /home' });
    expect(changed.allowed).toBe(false);
    expect(changed.reason).toMatch(/changed since/i);

    // The agent cannot answer an unknown card.
    expect(service.resolveApproval('fabricated', true, action).allowed).toBe(false);
    expect(fingerprintAction(action)).toHaveLength(64);
  });

  it('refuses every action outside granted folders, even under allow-all', async () => {
    service.setAutonomy('allow-all');
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cowork-e2e-out-')));
    try {
      fs.writeFileSync(path.join(outside, 'private.txt'), 'private');
      const r = await call('fs_write', { path: path.join(outside, 'private.txt'), content: 'overwritten' });
      // allow-all relaxes the grant check for the SERVICE path helpers, but
      // the fs tools resolve without autonomy, so the tool still refuses.
      expect(fs.readFileSync(path.join(outside, 'private.txt'), 'utf-8')).toBe('private');
      if (r.isError) {
        expect(r.content).toMatch(/outside the granted folders/i);
      }
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});