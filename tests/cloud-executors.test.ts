import { describe, it, expect } from 'vitest';
import { SshExecutor } from '../src/main/sandbox/ssh-executor';
import { DaytonaExecutor } from '../src/main/sandbox/daytona-executor';

describe('Remote Cloud / SSH Executors (Hermes-inspired)', () => {
  it('instantiates SshExecutor and manages lifecycle', async () => {
    const ssh = new SshExecutor();
    await ssh.initialize({
      workspacePath: '/remote/workspace',
      host: '192.168.1.100',
      user: 'ubuntu',
    } as any);

    expect(ssh).toBeDefined();
    await ssh.shutdown();
  });

  it('instantiates DaytonaExecutor and manages lifecycle', async () => {
    const daytona = new DaytonaExecutor();
    await daytona.initialize({
      workspacePath: '/workspace',
      workspaceId: 'ws-sample-123',
    } as any);

    expect(daytona).toBeDefined();
    await daytona.shutdown();
  });
});
