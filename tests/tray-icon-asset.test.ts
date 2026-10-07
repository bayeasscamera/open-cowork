import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..');
const read = (rel: string): Buffer => readFileSync(resolve(root, rel));

describe('windows tray icon asset', () => {
  it('is a multi-resolution .ico whose entries are DIB, like resources/icon.ico', () => {
    const buf = read('resources/tray-icon.ico');

    expect(buf.readUInt16LE(0), 'reserved').toBe(0);
    expect(buf.readUInt16LE(2), 'type = icon').toBe(1);
    const count = buf.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(2);

    const sizes: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const off = 6 + i * 16;
      const w = buf[off] || 256;
      const h = buf[off + 1] || 256;
      const dataOff = buf.readUInt32LE(off + 12);
      // A DIB entry opens on a BITMAPINFOHEADER, whose first field is its own
      // size: 40. A PNG-compressed entry would start with the PNG signature
      // instead — that form is only mandatory at 256px and is less widely
      // decoded, so every entry here must be a DIB.
      expect(buf.readUInt32LE(dataOff), `${w}x${h} entry is a DIB`).toBe(40);
      sizes.push(`${w}x${h}`);
    }
    expect(sizes).toEqual(['16x16', '32x32']);
  });

  it('is declared in the Windows extraResources so it reaches the packaged app', () => {
    const yml = read('electron-builder.yml').toString('utf8');
    const win = yml.slice(yml.indexOf('\nwin:'), yml.indexOf('\nmac:'));
    expect(win).toContain('resources/tray-icon.ico');
  });

  it('is decoded before use, with the .png kept as the fallback', () => {
    const index = read('src/main/index.ts').toString('utf8');
    const setup = index.slice(
      index.indexOf('function setupTray() {'),
      index.indexOf('let windowToggleAccelerator')
    );
    // An .ico the platform cannot read would hand `Tray` an empty image, i.e. an
    // invisible icon — worse than the single-size .png. So the decode result is
    // checked and the .png is kept when nothing comes back.
    expect(setup).toContain('nativeImage.createFromPath');
    expect(setup).toContain('.isEmpty()');
    expect(setup).toContain('tray-icon.png');
  });
});
