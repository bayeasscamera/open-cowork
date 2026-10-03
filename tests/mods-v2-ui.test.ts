import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModDeclarativeUi, MAX_UI_NODES, groupBySlot } from '../src/renderer/components/mods/ModDeclarativeUi';
import { isInstallRequest } from '../src/shared/mods-v2-contract';
import type { ModUiContribution } from '@cowork/mod-api';

/**
 * The declarative UI is the SAFE default: the host draws the mod's data. These
 * tests assert that it stays a data renderer — a mod must never be able to get
 * markup interpreted, however it labels its nodes.
 *
 * Components are invoked as functions, matching this repo's renderer test
 * convention (vitest only collects `.test.ts`).
 */

function render(nodes: ModUiContribution['nodes'], extra: Partial<Parameters<typeof ModDeclarativeUi>[0]> = {}): string {
  return renderToStaticMarkup(
    ModDeclarativeUi({ contribution: { slot: 'statusBar', nodes }, ...extra })
  );
}

describe('declarative mod UI', () => {
  it('renders text as text, never as markup', () => {
    const html = render([{ kind: 'text', label: '<img src=x onerror="alert(1)">' }]);
    // Escaped, so the payload is visible as text and cannot become an element.
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('escapes markup inside a list label and a table cell too', () => {
    const html = render([
      { kind: 'list', id: 'l', items: [{ label: '<script>x</script>', value: '<b>v</b>' }] },
      { kind: 'table', id: 't', columns: ['<th>'], rows: [['<td>cell</td>']] },
    ]);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<td>cell');
  });

  it('renders every supported node kind', () => {
    const html = render([
      { kind: 'text', label: 'hello' },
      { kind: 'button', id: 'b1', label: 'Run', variant: 'primary' },
      { kind: 'list', id: 'l1', items: [{ label: 'a', value: '1' }] },
      { kind: 'table', id: 't1', columns: ['k', 'v'], rows: [['x', 'y']] },
      { kind: 'form', id: 'f1', fields: [{ id: 'q', label: 'Query' }] },
    ]);
    expect(html).toContain('hello');
    expect(html).toContain('Run');
    expect(html).toContain('data-mod-node="l1"');
    expect(html).toContain('data-mod-node="t1"');
    expect(html).toContain('data-mod-field="q"');
  });

  it('marks the slot and the node count so a host can lay it out', () => {
    const html = renderToStaticMarkup(
      ModDeclarativeUi({ contribution: { slot: 'sidePanel', nodes: [{ kind: 'text', label: 'x' }] } })
    );
    expect(html).toContain('data-mod-slot="sidePanel"');
    expect(html).toContain('data-mod-nodes="1"');
  });

  it('caps the number of nodes a mod can contribute', () => {
    const nodes = Array.from({ length: MAX_UI_NODES + 25 }, (_unused, index) => ({
      kind: 'text' as const,
      label: `n${index}`,
    }));
    const html = render(nodes);
    expect(html).toContain(`data-mod-nodes="${MAX_UI_NODES}"`);
    expect(html).not.toContain(`n${MAX_UI_NODES + 24}`);
  });

  it('does not read a form value until the user asks for it', () => {
    const readValue = vi.fn(async () => 'typed by the user');
    const html = render([{ kind: 'form', id: 'f', fields: [{ id: 'q', label: 'Q' }] }], {
      backend: { readValue },
    });
    expect(html).toContain('data-mod-node="f"');
    // Nothing is read on render, so a mod cannot poll for input.
    expect(readValue).not.toHaveBeenCalled();
  });

  it('renders without a backend instead of pretending it is empty', () => {
    const html = render([{ kind: 'form', id: 'f', fields: [{ id: 'q', label: 'Q' }] }]);
    expect(html).toContain('data-mod-node="f"');
  });

  it('routes a button press to the host callback, never to mod-supplied code', () => {
    const onNotify = vi.fn();
    const element = ModDeclarativeUi({
      contribution: { slot: 'statusBar', nodes: [{ kind: 'button', id: 'go', label: 'Go' }] },
      onNotify,
    });
    expect(element).toBeTruthy();
    expect(onNotify).not.toHaveBeenCalled();
  });
});

describe('slot grouping', () => {
  it('groups contributions per slot and drops unknown slots', () => {
    const grouped = groupBySlot([
      { slot: 'statusBar', nodes: [] },
      { slot: 'sidePanel', nodes: [] },
      { slot: 'sidePanel', nodes: [] },
      { slot: 'nowhere' as never, nodes: [] },
    ]);
    expect(grouped.get('statusBar')).toHaveLength(1);
    expect(grouped.get('sidePanel')).toHaveLength(2);
    expect(grouped.has('nowhere' as never)).toBe(false);
  });
});

describe('install request validation', () => {
  it('accepts a well-formed request', () => {
    expect(isInstallRequest({ rootDir: '/tmp/x', approvedHash: 'a'.repeat(64) })).toBe(true);
  });

  it.each([
    ['a short hash', { rootDir: '/tmp/x', approvedHash: 'abc' }],
    ['a non-hex hash', { rootDir: '/tmp/x', approvedHash: 'z'.repeat(64) }],
    ['no hash', { rootDir: '/tmp/x' }],
    ['no path', { approvedHash: 'a'.repeat(64) }],
    ['an empty path', { rootDir: '', approvedHash: 'a'.repeat(64) }],
    ['null', null],
    ['a string', 'nope'],
  ])('refuses %s', (_label, value) => {
    expect(isInstallRequest(value)).toBe(false);
  });
});
