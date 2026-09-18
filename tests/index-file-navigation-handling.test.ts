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

  it('delegates navigation URL classification to the shared policy module', () => {
    const source = fs.readFileSync(indexPath, 'utf8');
    expect(source).toContain(
      "import { NavigationUrlPolicy } from './utils/navigation-url-policy';"
    );
    expect(source).toContain('new NavigationUrlPolicy(process.env.VITE_DEV_SERVER_URL)');
    expect(source.match(/navigationPolicy\.isExternalUrl\(url\)/g)).toHaveLength(2);
    expect(source.match(/navigationPolicy\.extractLocalPath\(url\)/g)).toHaveLength(3);
    // The classification logic must not be duplicated inline anymore.
    expect(source).not.toContain('const isExternalUrl =');
    expect(source).not.toContain('const extractLocalPathFromNavigationUrl =');
    // Local reveal targets still go through the folder reveal helper.
    expect(source).toContain('void revealNavigationTarget(url);');
    expect(source).toContain('return revealFileInFolder(localPath);');
  });
});
