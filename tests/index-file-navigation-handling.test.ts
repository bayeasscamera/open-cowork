import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const indexPath = path.resolve(process.cwd(), 'src/main/index.ts');

describe('Main process file navigation handling', () => {
  it('routes external navigation and IPC through the main-process validator', () => {
    const source = fs.readFileSync(indexPath, 'utf8');
    expect(source.match(/void safeOpenExternal\(url\);/g)).toHaveLength(2);
    expect(source).toContain(
      "ipcMain.handle('shell.openExternal', (_event, url: unknown) => safeOpenExternal(url));"
    );
    expect(source).not.toContain('shell.openExternal(url)');
  });

  it('treats raw file:// links as local reveal targets in window navigation hooks', () => {
    const source = fs.readFileSync(indexPath, 'utf8');

    expect(source).toContain("if (parsed.protocol === 'file:') {");
    expect(source).toContain('return localPathFromFileUrl(url);');
    expect(source).toContain('void revealNavigationTarget(url);');
    expect(source).toContain('return revealFileInFolder(localPath);');
  });
});
