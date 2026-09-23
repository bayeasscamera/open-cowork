/**
 * @module shared/test-failures
 *
 * Pure parsing of a test run's output, used to re-run only the files that
 * failed instead of the whole suite. Shared so the main process can build the
 * narrowed command and the renderer can explain what will be re-run.
 *
 * Everything here is deliberately strict: a candidate has to look like a
 * relative path to a test file inside the workspace. Absolute paths, options,
 * traversal segments and control characters are rejected, so a crafted test
 * name can never turn a re-run into an arbitrary command.
 */

/** Hard cap on how many files a single targeted re-run may name. */
export const MAX_FAILED_TEST_FILES = 20;

const JS_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const PYTHON_TEST_FILE = /^(?:test_.*|.*_test)\.py$/i;
const ABSOLUTE_LIKE = /^(?:[a-zA-Z]:[\\/]|[\\/])/;

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * True when the value is a relative path to a test file that may safely be
 * passed to a whitelisted test command.
 */
export function isRerunnableTestPath(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const candidate = value.trim();
  if (!candidate || candidate.length > 400) return false;
  // A leading dash would be read as an option, never as a path.
  if (candidate.startsWith('-')) return false;
  if (candidate.includes(':')) return false;
  if (hasControlCharacters(candidate)) return false;
  if (ABSOLUTE_LIKE.test(candidate)) return false;
  const segments = candidate.split(/[\\/]/);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return false;
  }
  const name = segments[segments.length - 1];
  return JS_TEST_FILE.test(name) || PYTHON_TEST_FILE.test(name);
}

function failedFileFromLine(rawLine: string): string | null {
  const line = rawLine.trim();
  if (!line) return null;

  // pytest: 'FAILED tests/test_a.py::test_b - AssertionError'
  const pytest = /^(?:FAILED|ERROR)\s+(\S+)/.exec(line);
  if (pytest) {
    const file = pytest[1].split('::')[0];
    return isRerunnableTestPath(file) ? file : null;
  }

  // vitest / jest: 'FAIL  tests/a.test.ts > suite > name',
  // '❯ tests/a.test.ts (3 tests | 1 failed)', '✗ src/a.spec.tsx'
  const prefixed = /^(?:FAIL|❯|✗|✕|×)\s+(.+)$/.exec(line);
  if (!prefixed) return null;

  let rest = prefixed[1].trim();
  const suiteSeparator = rest.indexOf(' > ');
  if (suiteSeparator >= 0) rest = rest.slice(0, suiteSeparator);
  // Drop a trailing ' (3 tests | 1 failed)' style counter.
  rest = rest.replace(/\s+\(.*$/, '').trim();
  rest = rest.replace(/^['"`]|['"`]$/g, '');
  return isRerunnableTestPath(rest) ? rest : null;
}

/**
 * Test files that failed, extracted from a run's combined output. Returns a
 * sorted, de-duplicated list of at most max entries.
 */
export function parseFailedTestFiles(
  output: string,
  max: number = MAX_FAILED_TEST_FILES
): string[] {
  if (typeof output !== 'string' || !output) return [];
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_FAILED_TEST_FILES;
  const found = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const candidate = failedFileFromLine(rawLine);
    if (!candidate) continue;
    found.add(candidate);
    if (found.size >= limit) break;
  }
  return [...found].sort();
}
