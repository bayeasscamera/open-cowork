import { describe, expect, it } from 'vitest';
import { AUTO_TEXT_DIRECTION_PROPS } from '../src/renderer/utils/text-direction';

describe('automatic chat text direction', () => {
  it('delegates direction detection to the browser for every text block', () => {
    expect(AUTO_TEXT_DIRECTION_PROPS.dir).toBe('auto');
  });

  it('isolates mixed-direction text from the surrounding interface', () => {
    expect(AUTO_TEXT_DIRECTION_PROPS.style.unicodeBidi).toBe('plaintext');
  });
});
