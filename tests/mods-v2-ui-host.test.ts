import { describe, expect, it } from 'vitest';
import {
  MAX_UI_CONTRIBUTION_NODES,
  MODS_UI_CONTRIBUTIONS_CHANGED,
  ModUiHost,
  validateContribution,
} from '../src/main/mods/v2/ui-host';
import { isUiValueReport } from '../src/shared/mods-v2-contract';
import type { ModUiContribution } from '@cowork/mod-api';

function makeHost() {
  const sent: Array<{ channel: string; payload: unknown }> = [];
  const host = new ModUiHost({
    getWebContents: () => ({ send: (channel, payload) => void sent.push({ channel, payload }) }),
  });
  return { host, sent };
}

const TEXT: ModUiContribution = { slot: 'settingsTab', nodes: [{ kind: 'text', label: 'hello' }] };

describe('validateContribution', () => {
  it('accepts a well-formed contribution', () => {
    const result = validateContribution(TEXT);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['not an object', null],
    ['an array', []],
    ['an unknown slot', { slot: 'nowhere', nodes: [] }],
    ['a non-string slot', { slot: 42, nodes: [] }],
    ['missing nodes', { slot: 'settingsTab' }],
    ['a non-array nodes', { slot: 'settingsTab', nodes: {} }],
    ['an unknown node kind', { slot: 'settingsTab', nodes: [{ kind: 'iframe', src: 'x' }] }],
    ['a node missing its id', { slot: 'settingsTab', nodes: [{ kind: 'button', label: 'go' }] }],
    [
      'a list item without a label',
      { slot: 'settingsTab', nodes: [{ kind: 'list', id: 'l', items: [{ value: '1' }] }] },
    ],
    [
      'a table row with a non-string cell',
      { slot: 'settingsTab', nodes: [{ kind: 'table', id: 't', columns: ['a'], rows: [[1]] }] },
    ],
  ])('refuses %s', (_label, input) => {
    expect(validateContribution(input).ok).toBe(false);
  });

  it('refuses more nodes than the cap', () => {
    const nodes = Array.from({ length: MAX_UI_CONTRIBUTION_NODES + 1 }, () => ({
      kind: 'text' as const,
      label: 'x',
    }));
    expect(validateContribution({ slot: 'settingsTab', nodes }).ok).toBe(false);
  });

  it('accepts exactly at the cap', () => {
    const nodes = Array.from({ length: MAX_UI_CONTRIBUTION_NODES }, () => ({
      kind: 'text' as const,
      label: 'x',
    }));
    expect(validateContribution({ slot: 'settingsTab', nodes }).ok).toBe(true);
  });
});

describe('ModUiHost', () => {
  it('stores a contribution and pushes the full list to the renderer', async () => {
    const { host, sent } = makeHost();
    await host.contribute('mod-a', TEXT);

    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe(MODS_UI_CONTRIBUTIONS_CHANGED);
    expect(host.list()).toEqual([{ modId: 'mod-a', contribution: TEXT }]);
  });

  it('re-contributing the same slot replaces instead of accumulating', async () => {
    const { host, sent } = makeHost();
    await host.contribute('mod-a', TEXT);
    const replacement: ModUiContribution = {
      slot: 'settingsTab',
      nodes: [{ kind: 'text', label: 'updated' }],
    };
    await host.contribute('mod-a', replacement);

    expect(host.list()).toEqual([{ modId: 'mod-a', contribution: replacement }]);
    expect(sent).toHaveLength(2);
  });

  it('keeps contributions for different slots and mods side by side', async () => {
    const { host } = makeHost();
    await host.contribute('mod-a', TEXT);
    await host.contribute('mod-a', { slot: 'sidePanel', nodes: [{ kind: 'text', label: 'side' }] });
    await host.contribute('mod-b', TEXT);

    expect(host.list()).toHaveLength(3);
    expect(host.list().map((entry) => entry.modId).sort()).toEqual(['mod-a', 'mod-a', 'mod-b']);
  });

  it('throws on an invalid contribution so the mod sees the refusal', async () => {
    const { host } = makeHost();
    await expect(
      host.contribute('mod-a', { slot: 'nowhere', nodes: [] } as unknown as ModUiContribution)
    ).rejects.toThrow(/refused/);
    expect(host.list()).toEqual([]);
  });

  it('does not send when no web contents is available (window not ready)', async () => {
    const host = new ModUiHost({ getWebContents: () => null });
    await host.contribute('mod-a', TEXT);
    expect(host.list()).toHaveLength(1);
  });

  it('round-trips a reported form value to the owning mod', async () => {
    const { host } = makeHost();
    expect(await host.readValue('mod-a', 'field-1')).toBeUndefined();

    host.reportValue('mod-a', 'field-1', 'typed by the user');
    expect(await host.readValue('mod-a', 'field-1')).toBe('typed by the user');
    // Another mod's address is a different key.
    expect(await host.readValue('mod-b', 'field-1')).toBeUndefined();
  });

  it('forwards a notify to the renderer with the mod id attached', async () => {
    const { host, sent } = makeHost();
    await host.notify('mod-a', 'done', 'info');
    expect(sent).toEqual([
      { channel: 'modsV2.uiNotify', payload: { modId: 'mod-a', message: 'done', level: 'info' } },
    ]);
  });
});

describe('isUiValueReport', () => {
  it('accepts a well-formed report and carries the value untouched', () => {
    expect(isUiValueReport({ modId: 'm', nodeId: 'n', value: { nested: ['x'] } })).toBe(true);
  });

  it.each([
    ['missing modId', { nodeId: 'n', value: 1 }],
    ['missing nodeId', { modId: 'm', value: 1 }],
    ['an empty modId', { modId: '', nodeId: 'n', value: 1 }],
    ['a non-object', 'report'],
    ['null', null],
  ])('refuses %s', (_label, input) => {
    expect(isUiValueReport(input)).toBe(false);
  });
});
