import { describe, expect, it } from 'vitest';
import {
  MAX_FAILED_TEST_FILES,
  isRerunnableTestPath,
  parseFailedTestFiles,
} from '../src/shared/test-failures';

describe('isRerunnableTestPath', () => {
  it('accepts relative JavaScript and Python test files', () => {
    expect(isRerunnableTestPath('tests/a.test.ts')).toBe(true);
    expect(isRerunnableTestPath('src/deep/a.spec.tsx')).toBe(true);
    expect(isRerunnableTestPath('src/a.test.mjs')).toBe(true);
    expect(isRerunnableTestPath('tests/test_a.py')).toBe(true);
    expect(isRerunnableTestPath('tests/a_test.py')).toBe(true);
    expect(isRerunnableTestPath('tests\\windows\\a.test.ts')).toBe(true);
  });

  it('rejects absolute paths', () => {
    expect(isRerunnableTestPath('/etc/passwd.test.ts')).toBe(false);
    expect(isRerunnableTestPath('C:\\proj\\a.test.ts')).toBe(false);
    expect(isRerunnableTestPath('\\\\server\\share\\a.test.ts')).toBe(false);
  });

  it('rejects traversal segments', () => {
    expect(isRerunnableTestPath('../a.test.ts')).toBe(false);
    expect(isRerunnableTestPath('tests/../a.test.ts')).toBe(false);
    expect(isRerunnableTestPath('./a.test.ts')).toBe(false);
    expect(isRerunnableTestPath('tests//a.test.ts')).toBe(false);
  });

  it('rejects anything that is not a test file', () => {
    expect(isRerunnableTestPath('tests/helpers.ts')).toBe(false);
    expect(isRerunnableTestPath('README.md')).toBe(false);
    expect(isRerunnableTestPath('tests/a.test.ts:12')).toBe(false);
  });

  it('rejects options, control characters and junk', () => {
    expect(isRerunnableTestPath('--reporter=a.test.ts')).toBe(false);
    expect(isRerunnableTestPath('a.test.ts\u0000')).toBe(false);
    expect(isRerunnableTestPath('')).toBe(false);
    expect(isRerunnableTestPath('   ')).toBe(false);
    expect(isRerunnableTestPath(42)).toBe(false);
    expect(isRerunnableTestPath(null)).toBe(false);
    expect(isRerunnableTestPath('x'.repeat(401) + '.test.ts')).toBe(false);
  });
});

describe('parseFailedTestFiles', () => {
  it('reads the vitest summary markers', () => {
    const output = [
      ' FAIL  tests/b.test.ts > suite > works',
      ' ✓ tests/ok.test.ts (2 tests) 12ms',
      ' ❯ tests/a.test.ts (3 tests | 1 failed) 40ms',
    ].join('\n');
    expect(parseFailedTestFiles(output)).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
  });

  it('reads a jest FAIL line', () => {
    expect(parseFailedTestFiles('FAIL src/b.spec.tsx')).toEqual(['src/b.spec.tsx']);
  });

  it('reads pytest FAILED and ERROR lines', () => {
    const output = [
      'FAILED tests/test_a.py::test_one - AssertionError: boom',
      'ERROR tests/test_c.py::test_three',
    ].join('\n');
    expect(parseFailedTestFiles(output)).toEqual(['tests/test_a.py', 'tests/test_c.py']);
  });

  it('de-duplicates a file reported by several lines', () => {
    const output = [
      'FAIL tests/a.test.ts > suite > one',
      'FAIL tests/a.test.ts > suite > two',
    ].join('\n');
    expect(parseFailedTestFiles(output)).toEqual(['tests/a.test.ts']);
  });

  it('ignores lines that are not failures', () => {
    const output = [
      ' ✓ tests/a.test.ts (3 tests) 20ms',
      'Test Files  1 passed (1)',
      'FAIL tests/helpers.ts',
    ].join('\n');
    expect(parseFailedTestFiles(output)).toEqual([]);
  });

  it('ignores unsafe candidates even when they are marked as failures', () => {
    const output = [
      'FAIL /etc/passwd.test.ts',
      'FAIL ../../evil.test.ts',
      'FAIL --reporter=a.test.ts',
      'FAIL tests/real.test.ts',
    ].join('\n');
    expect(parseFailedTestFiles(output)).toEqual(['tests/real.test.ts']);
  });

  it('handles CRLF output and trailing suites', () => {
    expect(parseFailedTestFiles('FAIL  tests/a.test.ts > s > c\r\n')).toEqual(['tests/a.test.ts']);
  });

  it('caps the number of files', () => {
    const output = Array.from({ length: 40 }, (_, index) => 'FAIL tests/t' + index + '.test.ts').join('\n');
    expect(parseFailedTestFiles(output)).toHaveLength(MAX_FAILED_TEST_FILES);
    expect(parseFailedTestFiles(output, 3)).toHaveLength(3);
  });

  it('returns nothing for empty or non-string output', () => {
    expect(parseFailedTestFiles('')).toEqual([]);
    expect(parseFailedTestFiles(undefined as unknown as string)).toEqual([]);
  });
});
