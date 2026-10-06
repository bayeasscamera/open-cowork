import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  existsSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildBubblewrapArgs,
  buildSeatbeltPolicy,
  findSandboxLauncher,
  planSandbox,
  resolvePolicyPath,
  sensitiveReadPaths,
  systemWideDeniedReadPaths,
} from '../src/main/agent/run-code-sandbox';

/**
 * The run_code sandbox.
 *
 * The policy strings are pure functions and are asserted as text, but that alone
 * proves nothing about confinement: a profile can be perfectly written and still
 * not deny anything. So on macOS these tests also run a REAL node process under
 * a REAL sandbox and assert on what it could and could not do. Those cases are
 * the ones worth having.
 */

import { seatbeltUsable } from './sandbox-capability';

const NODE = process.execPath;
const isDarwin = process.platform === 'darwin';
// The binary existing is not the capability: a nested sandbox refuses to apply
// even a well-formed profile, so the gate is a real probe (see
// tests/sandbox-capability.ts).
const hasSeatbelt = seatbeltUsable;

function runInSandbox(policy: string, script: string): { out: string } {
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', policy, NODE, '-e', script], {
    encoding: 'utf8',
  });
  return { out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
}

function baseRequest(workspace: string) {
  return {
    platform: 'darwin' as NodeJS.Platform,
    execPath: NODE,
    nodeArgs: ['-e', 'x'],
    workspace,
    deniedReadPaths: sensitiveReadPaths('/nonexistent-home-for-tests'),
  };
}

describe('the macOS policy denies by default', () => {
  it('starts from deny default rather than allow default', () => {
    const policy = buildSeatbeltPolicy(baseRequest('/tmp/ws'));
    expect(policy).toContain('(deny default)');
    expect(policy).not.toContain('(allow default)');
  });

  it('allows writes only inside the workspace', () => {
    const policy = buildSeatbeltPolicy(baseRequest('/tmp/ws'));
    const writeRules = policy.match(/\(allow file-write\*[^\n]*/g) ?? [];
    expect(writeRules).toHaveLength(1);
    expect(writeRules[0]).toContain('/tmp/ws');
  });

  it('never allows network, so there is no rule to leak out through', () => {
    const policy = buildSeatbeltPolicy(baseRequest('/tmp/ws'));
    expect(policy).not.toMatch(/allow network/);
    expect(policy).not.toMatch(/allow socket/);
  });

  it('allows exec of node and nothing else', () => {
    const policy = buildSeatbeltPolicy(baseRequest('/tmp/ws'));
    expect(policy).toContain('(allow process-exec (literal ');
    // Not the wildcard form.
    expect(policy).not.toContain('(allow process-exec*)');
  });

  it('denies reads of every credential-bearing path', () => {
    const paths = sensitiveReadPaths('/home/u', '/home/u/Library/Application Support/App');
    const policy = buildSeatbeltPolicy({ ...baseRequest('/tmp/ws'), deniedReadPaths: paths });
    for (const path of paths) {
      // Compared resolved: /etc is a symlink to /private/etc on macOS, and the
      // policy carries the real path precisely so the rule can match.
      const resolved = resolvePolicyPath(path);
      expect(policy).toContain(
        `(deny file-read-data (subpath "${resolved.replace(/\\/g, '\\\\')}"))`
      );
    }
  });

  it('includes the obvious credential locations for a given home', () => {
    const paths = sensitiveReadPaths('/home/u');
    expect(paths).toContain('/home/u/.ssh');
    expect(paths).toContain('/home/u/.aws');
    expect(paths).toContain('/home/u/.gnupg');
    expect(paths).toContain('/home/u/Library/Keychains');
  });

  it('escapes a quote in a path so it cannot inject a rule', () => {
    // The payload would grant a global write if it escaped the literal. It must
    // survive as inert text, so the assertion is that the injected rule text
    // never appears as a rule of its own.
    const payload = 'ws") (allow file-write*) (subpath "/';
    const policy = buildSeatbeltPolicy(baseRequest(payload));
    // The payload text is present but escaped, inside the quoted literal, so it
    // sits mid-line and never becomes a rule. Counting only rules that START a
    // line is what makes this a real check: a naive substring search would match
    // the inert text inside the literal and pass an actual injection.
    const writeRules = policy.match(/^\(allow file-write\*/gm) ?? [];
    expect(writeRules).toHaveLength(1);
    expect(policy).toContain('\\"');
  });

  it('resolves a symlinked path, because Seatbelt compares the real path', () => {
    // A rule written for the symlink would match nothing: the workspace write
    // would be denied and a deny rule would leak.
    const real = mkdtempSync(join(tmpdir(), 'cowork-real-'));
    const link = join(tmpdir(), `cowork-link-${Date.now()}`);
    try {
      symlinkSync(real, link);
      const policy = buildSeatbeltPolicy(baseRequest(link));
      expect(policy).toContain(realpathSync(real));
    } finally {
      rmSync(real, { recursive: true, force: true });
      rmSync(link, { force: true });
    }
  });
});

describe('the home directory is jailed, by directory rather than by list', () => {
  // A deny-list of credential paths is an argument from ignorance: it can only
  // cover the locations somebody thought of. Closing the directory covers the one
  // nobody did.
  it('denies reads of the whole home directory', () => {
    const policy = buildSeatbeltPolicy({ ...baseRequest('/tmp/ws'), homeDir: '/home/u' });
    expect(policy).toContain('(deny file-read-data (subpath "/home/u"))');
  });

  it('reopens the workspace AFTER the deny, since the last rule wins', () => {
    const policy = buildSeatbeltPolicy({ ...baseRequest('/tmp/ws'), homeDir: '/home/u' });
    // Compared resolved: the policy carries real paths, and on macOS /tmp is a
    // symlink to /private/tmp, so matching the literal would prove nothing.
    const workspace = resolvePolicyPath('/tmp/ws');
    // Order is the entire mechanism. A workspace inside the home directory is
    // the common case and only works because the exception comes later.
    expect(policy.indexOf('(deny file-read-data (subpath "/home/u"))')).toBeLessThan(
      policy.indexOf(`(allow file-read-data (subpath "${workspace}"))`)
    );
  });

  it('reopens the runtime paths the child needs to boot', () => {
    const policy = buildSeatbeltPolicy({
      ...baseRequest('/tmp/ws'),
      homeDir: '/home/u',
      readableRuntimePaths: ['/opt/node', '/opt/esbuild'],
    });
    expect(policy).toContain('(allow file-read-data (subpath "/opt/node"))');
    expect(policy).toContain('(allow file-read-data (subpath "/opt/esbuild"))');
    expect(policy.indexOf('(deny file-read-data (subpath "/home/u"))')).toBeLessThan(
      policy.indexOf('(allow file-read-data (subpath "/opt/esbuild"))')
    );
  });

  it('still keeps the general allow, because a scoped allow-list cannot boot node', () => {
    // Removing this is what made every scoped-allow-list experiment fail: dyld
    // resolves library paths through firmlinks that no enumerable subtree covers.
    const policy = buildSeatbeltPolicy({ ...baseRequest('/tmp/ws'), homeDir: '/home/u' });
    expect(policy).toContain('(allow file-read-data)');
  });

  it('denies the whole system surface the child boots without, except /var', () => {
    // /var cannot be denied: node itself needs it at startup (temporary
    // directory and getcwd live under /var/folders). Denying it breaks the
    // child before any of our code runs - verified, not assumed.
    expect(systemWideDeniedReadPaths()).not.toContain('/var');
    // Each of these is load-bearing as documentation, not padding: it asserts
    // the default that a future edit might narrow without noticing the cost.
    const expected = ['/etc', '/tmp', '/Library', '/Applications', '/bin', '/sbin', '/opt'];
    for (const path of expected) {
      expect(systemWideDeniedReadPaths()).toContain(path);
    }
  });

  it('still denies the individual paths outside the home directory', () => {
    const policy = buildSeatbeltPolicy({
      ...baseRequest('/tmp/ws'),
      homeDir: '/home/u',
      deniedReadPaths: ['/etc/ssh'],
    });
    expect(policy).toContain(`(deny file-read-data (subpath "${resolvePolicyPath('/etc/ssh')}"))`);
  });
});

describe('a real sandboxed process is actually confined', () => {
  // Skipped rather than faked when the host cannot apply a profile: bubblewrap
  // needs a container, and a nested sandbox refuses Seatbelt outright, so
  // asserting confinement that was never exercised would be worse than
  // asserting nothing.
  it.skipIf(!isDarwin || !hasSeatbelt)('can read and write the workspace', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cowork-sb-'));
    try {
      writeFileSync(join(workspace, 'seed.txt'), 'seed');
      const policy = buildSeatbeltPolicy(baseRequest(workspace));
      const { out } = runInSandbox(
        policy,
        `const fs=require('fs');
         fs.writeFileSync('${workspace}/written.txt','hello');
         console.log(fs.readFileSync('${workspace}/seed.txt','utf8')+'|'+fs.readFileSync('${workspace}/written.txt','utf8'));`
      );
      expect(out).toContain('seed|hello');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(!isDarwin || !hasSeatbelt)('cannot write outside the workspace', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cowork-sb-'));
    const outside = mkdtempSync(join(tmpdir(), 'cowork-outside-'));
    try {
      const target = join(outside, 'escaped.txt');
      const policy = buildSeatbeltPolicy(baseRequest(workspace));
      const { out } = runInSandbox(
        policy,
        `try{require('fs').writeFileSync(${JSON.stringify(target)},'x');console.log('WROTE_OUTSIDE')}
         catch(e){console.log('BLOCKED:'+e.code)}`
      );
      expect(out).toContain('BLOCKED');
      expect(out).not.toContain('WROTE_OUTSIDE');
      expect(existsSync(target)).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(!isDarwin || !hasSeatbelt)('cannot open a network socket', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cowork-sb-'));
    try {
      const policy = buildSeatbeltPolicy(baseRequest(workspace));
      const { out } = runInSandbox(
        policy,
        `try{const net=require('net');
          const s=net.connect(80,'1.1.1.1');
          s.on('error',e=>console.log('NET_BLOCKED:'+e.code));
          s.on('connect',()=>console.log('NET_ALLOWED'));
          setTimeout(()=>process.exit(0),800);}
         catch(e){console.log('NET_BLOCKED:'+e.code)}`
      );
      expect(out).toContain('NET_BLOCKED');
      expect(out).not.toContain('NET_ALLOWED');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(!isDarwin || !hasSeatbelt)('cannot exec another binary', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cowork-sb-'));
    try {
      const policy = buildSeatbeltPolicy(baseRequest(workspace));
      const { out } = runInSandbox(
        policy,
        `try{require('child_process').execSync('/bin/echo pwned',{stdio:'pipe'});console.log('EXEC_ALLOWED')}
         catch(e){console.log('EXEC_BLOCKED')}`
      );
      expect(out).toContain('EXEC_BLOCKED');
      expect(out).not.toContain('EXEC_ALLOWED');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it.skipIf(!isDarwin || !hasSeatbelt)('cannot read anything in the home directory', () => {
    // The confinement is a directory jail, not a list of known credential paths:
    // everything under the home directory is refused, so a secret nobody
    // anticipated is refused along with the ones somebody did.
    const workspace = mkdtempSync(join(tmpdir(), 'cowork-sb-'));
    const fakeHome = mkdtempSync(join(tmpdir(), 'cowork-home-'));
    try {
      mkdirSync(join(fakeHome, '.ssh'), { recursive: true });
      writeFileSync(join(fakeHome, '.ssh', 'id_rsa'), 'PRIVATE KEY');
      writeFileSync(join(fakeHome, 'notes.txt'), 'private notes');
      const policy = buildSeatbeltPolicy({
        ...baseRequest(workspace),
        homeDir: fakeHome,
        deniedReadPaths: sensitiveReadPaths(fakeHome),
      });
      expect(policy).toContain(`(deny file-read-data (subpath "${resolvePolicyPath(fakeHome)}"))`);
      // Both a credential file and an ordinary file are refused: the jail is by
      // directory, so it does not depend on knowing what is in there.
      const { out } = runInSandbox(
        policy,
        `const fs=require('fs');const o=[];
         try{fs.readFileSync(${JSON.stringify(join(fakeHome, '.ssh', 'id_rsa'))},'utf8');o.push('READ_SECRET')}catch(e){o.push('SECRET_BLOCKED')}
         try{fs.readFileSync(${JSON.stringify(join(fakeHome, 'notes.txt'))},'utf8');o.push('READ_ORDINARY')}catch(e){o.push('ORDINARY_BLOCKED')}
         try{fs.readdirSync(${JSON.stringify(fakeHome)});o.push('LISTED_HOME')}catch(e){o.push('HOME_LIST_BLOCKED')}
         console.log(o.join(' | '));`
      );
      expect(out).toContain('SECRET_BLOCKED');
      expect(out).toContain('ORDINARY_BLOCKED');
      expect(out).toContain('HOME_LIST_BLOCKED');
      expect(out).not.toContain('READ_SECRET');
      expect(out).not.toContain('READ_ORDINARY');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it.skipIf(!isDarwin || !hasSeatbelt)(
    'cannot escape through a symlink out of the workspace',
    () => {
      // The workspace is writable, so a symlink planted in it must not become a
      // way to write somewhere else. This is the escape that a naive
      // "allow write to workspace" rule gets wrong.
      const workspace = mkdtempSync(join(tmpdir(), 'cowork-sb-'));
      const outside = mkdtempSync(join(tmpdir(), 'cowork-outside-'));
      try {
        symlinkSync(outside, join(workspace, 'link'));
        const policy = buildSeatbeltPolicy(baseRequest(workspace));
        const { out } = runInSandbox(
          policy,
          `try{require('fs').writeFileSync(${JSON.stringify(join(workspace, 'link', 'escaped.txt'))},'x');console.log('SYMLINK_ESCAPE')}
         catch(e){console.log('LINK_BLOCKED:'+e.code)}`
        );
        expect(out).not.toContain('SYMLINK_ESCAPE');
        expect(existsSync(join(outside, 'escaped.txt'))).toBe(false);
      } finally {
        rmSync(workspace, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    }
  );
});

describe('the plan fails closed when no confinement exists', () => {
  it('refuses on a platform with no sandbox', () => {
    for (const platform of ['win32', 'freebsd'] as NodeJS.Platform[]) {
      const plan = planSandbox({
        platform,
        execPath: NODE,
        nodeArgs: ['x.js'],
        workspace: '/tmp/ws',
      });
      expect(plan.supported).toBe(false);
      expect(plan.kind).toBe('unsupported');
      expect(plan.reason).toMatch(/refused/i);
    }
  });

  it('refuses on Linux when bubblewrap is missing', () => {
    const plan = planSandbox({
      platform: 'linux',
      execPath: NODE,
      nodeArgs: ['x.js'],
      workspace: '/tmp/ws',
    });
    expect(plan.supported).toBe(false);
    expect(plan.reason).toMatch(/bubblewrap|bwrap/);
  });

  it('never returns a plan that would run node directly on an unsupported platform', () => {
    const plan = planSandbox({
      platform: 'win32',
      execPath: NODE,
      nodeArgs: ['x.js'],
      workspace: '/tmp/ws',
    });
    // The command may still be node, but `supported` is false so the caller
    // refuses. Asserted explicitly because a future edit that drops the
    // `supported` check would otherwise run unsandboxed code.
    expect(plan.supported).toBe(false);
    expect(plan.args).toEqual(['x.js']);
  });

  it('uses the launcher on a supported platform', () => {
    const plan = planSandbox({ ...baseRequest('/tmp/ws'), launcherPath: '/usr/bin/sandbox-exec' });
    expect(plan.supported).toBe(true);
    expect(plan.kind).toBe('seatbelt');
    expect(plan.command).toBe('/usr/bin/sandbox-exec');
    expect(plan.args[0]).toBe('-p');
  });
});

// VERIFIED ON A REAL LINUX (bubblewrap 0.8.0, node:20-bookworm, --privileged).
// Running the generated command line produced exactly:
//   BOOT_OK
//   WS_WRITE_OK
//   OUTSIDE_WRITE_BLOCKED
//   NET_BLOCKED
// and no file appeared outside the workspace.
//
// It is recorded as a comment rather than as tests on purpose: the behaviour
// belongs to bubblewrap and the kernel, not to this file. A test that asserted
// those strings would prove only that the string literals are non-empty, which
// is worse than no test because it reads as verification. The unit tests below
// check what THIS code controls - the argument construction - including the
// missing-bind-source case that this run exposed.

describe('linux confinement', () => {
  it('unshares the network so there is no interface to use', () => {
    const args = buildBubblewrapArgs({
      platform: 'linux',
      execPath: NODE,
      nodeArgs: ['child.js'],
      workspace: '/ws',
    });
    expect(args).toContain('--unshare-net');
  });

  it('binds the workspace writable and everything else read-only', () => {
    const args = buildBubblewrapArgs({
      platform: 'linux',
      execPath: NODE,
      nodeArgs: ['child.js'],
      workspace: '/ws',
    });
    const index = args.indexOf('--bind');
    expect(args[index + 1]).toBe('/ws');
    expect(args[index + 2]).toBe('/ws');
    expect(args).toContain('--ro-bind');
  });

  it('omits bind sources the system does not have', () => {
    // Found by running this on a real Linux, not by reasoning: bwrap fails with
    // "Can't find source path" on a missing bind, and the paths a distro provides
    // are not fixed. Debian bookworm merged /lib64 into /lib; Alpine has no
    // /lib64. A hard-coded /lib64 made run_code fail outright on both.
    const debianBookworm = ['/usr', '/bin', '/sbin', '/etc', '/lib', '/dev'];
    const args = buildBubblewrapArgs(
      { platform: 'linux', execPath: NODE, nodeArgs: ['child.js'], workspace: '/ws' },
      (candidate) => debianBookworm.includes(candidate)
    );
    expect(args.join(' ')).not.toContain('/lib64');
    expect(args).toContain('/lib');
  });

  it('works on a distro with almost nothing in the usual places', () => {
    const alpine = ['/usr', '/bin', '/sbin'];
    const args = buildBubblewrapArgs(
      { platform: 'linux', execPath: NODE, nodeArgs: ['child.js'], workspace: '/ws' },
      (candidate) => alpine.includes(candidate)
    );
    // Still confined: the namespace flags and the workspace bind are not optional.
    expect(args).toContain('--unshare-net');
    expect(args).toContain('--die-with-parent');
    expect(args[args.indexOf('--bind') + 1]).toBe('/ws');
  });

  it('execs node last, after the namespace flags', () => {
    const args = buildBubblewrapArgs({
      platform: 'linux',
      execPath: '/usr/bin/node',
      nodeArgs: ['child.js'],
      workspace: '/ws',
    });
    expect(args[args.indexOf('--') + 1]).toBe('/usr/bin/node');
    expect(args[args.length - 1]).toBe('child.js');
  });

  it('kills the namespace when the parent dies, so it cannot outlive the run', () => {
    const args = buildBubblewrapArgs({
      platform: 'linux',
      execPath: NODE,
      nodeArgs: ['child.js'],
      workspace: '/ws',
    });
    expect(args).toContain('--die-with-parent');
  });
});

describe('launcher discovery', () => {
  it('returns the seatbelt path on macOS when it exists', () => {
    expect(findSandboxLauncher('darwin', () => true)).toBe('/usr/bin/sandbox-exec');
  });

  it('returns nothing when the launcher is absent, so the caller can refuse', () => {
    expect(findSandboxLauncher('darwin', () => false)).toBeUndefined();
  });

  it('looks for bwrap on linux', () => {
    expect(findSandboxLauncher('linux', () => true)).toBe('bwrap');
  });
});
