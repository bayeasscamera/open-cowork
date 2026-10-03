import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const preBuildCheck = require('../scripts/pre-build-check.js') as {
  SUPPORTED_BUILD_TARGETS?: Record<string, readonly string[]>;
  buildCheckList: (platform: string, arch: string) => unknown[];
};

describe('official native release targets', () => {
  it('declares only currently supported macOS and Windows native targets', () => {
    expect(preBuildCheck.SUPPORTED_BUILD_TARGETS).toEqual({
      darwin: ['arm64'],
      linux: ['x64'],
      win32: ['x64'],
    });
  });

  it('retains runtime and sandbox-agent requirements for those official targets', () => {
    expect(() => preBuildCheck.buildCheckList('darwin', 'arm64')).not.toThrow();
    expect(() => preBuildCheck.buildCheckList('win32', 'x64')).not.toThrow();
    expect(() => preBuildCheck.buildCheckList('linux', 'x64')).not.toThrow();
  });

  it.each([
    ['darwin', 'x64'],
    ['win32', 'arm64'],
    ['linux', 'arm64'],
  ])('rejects %s/%s before checking release artifacts', (platform, arch) => {
    expect(() => preBuildCheck.buildCheckList(platform, arch)).toThrow(
      /unsupported release target/i
    );
  });
});
