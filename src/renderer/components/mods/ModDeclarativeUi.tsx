/**
 * Declarative mod UI, rendered by Cowork's own components.
 *
 * This is the DEFAULT and the safe mode: a mod returns data, and the host draws
 * it. That is a deliberate constraint, not a limitation of convenience — a mod
 * that shipped raw HTML into the main renderer would inherit the app's DOM, its
 * design system and its XSS surface, and "the mod was installed with your
 * approval" is not consent to that.
 *
 * A custom panel exists too, in an isolated iframe with a validated message
 * bridge (see the artifacts work). A mod chooses; the host enforces the sandbox.
 *
 * Nothing here interprets mod output as anything but text. Values are rendered as
 * React children, never as HTML, so a node label containing markup is displayed
 * rather than executed.
 */

import { useCallback, useState } from 'react';
import type { ModUiContribution, ModUiNode, ModUiSlot } from '@cowork/mod-api';

/** Cap the nodes one contribution may add — a mod cannot flood the slot. */
export const MAX_UI_NODES = 50;

export interface ModDeclarativeUiProps {
  contribution: ModUiContribution;
  /**
   * Host channel for reading a value the user submitted. Declared locally rather
   * than imported from the main process: the renderer must not depend on a
   * main-process module, and a null backend means "slot unavailable", not
   * "nothing to show".
   */
  backend?: { readValue: (modId: string, nodeId: string) => Promise<unknown> };
  onNotify?: (message: string, level: 'info' | 'warn' | 'error') => void;
}

function nodeKey(node: ModUiNode, index: number): string {
  const id = 'id' in node ? node.id : node.kind;
  return `${id}-${index}`;
}

/**
 * Read a value a user submitted through a contributed form.
 *
 * Goes back through the host, never through the mod: a form value is DATA the
 * user typed, and the host must be the one to decide what it is allowed to do.
 */
function useNodeValue(backend: ModDeclarativeUiProps['backend'], nodeId: string): [string, () => void] {
  const [value, setValue] = useState<string | null>(null);
  const read = useCallback(async () => {
    if (!backend) return;
    const next = await backend.readValue('', nodeId);
    setValue(typeof next === 'string' ? next : next === undefined ? null : JSON.stringify(next));
  }, [backend, nodeId]);
  return [value ?? '', () => void read()];
}

type FormNodeKind = Extract<ModUiNode, { kind: 'form' }>;

function FormNode({ node, backend }: { node: FormNodeKind; backend?: ModDeclarativeUiProps['backend'] }) {
  const [value, read] = useNodeValue(backend, node.id);
  return (
    <div className="mod-ui__form" data-mod-node={node.id}>
      {node.fields.map((field) => (
        <label key={field.id} className="mod-ui__field">
          <span>{field.label}</span>
          <input
            type="text"
            readOnly
            value={value}
            data-mod-field={field.id}
            onFocus={read}
          />
        </label>
      ))}
    </div>
  );
}

function Node({ node, backend, onNotify }: { node: ModUiNode; backend?: ModDeclarativeUiProps['backend']; onNotify?: ModDeclarativeUiProps['onNotify'] }) {
  switch (node.kind) {
    case 'text':
      return <p className="mod-ui__text">{node.label}</p>;
    case 'button':
      return (
        <button
          type="button"
          className={`mod-ui__button mod-ui__button--${node.variant ?? 'ghost'}`}
          data-mod-node={node.id}
          onClick={() => onNotify?.(node.label, 'info')}
        >
          {node.label}
        </button>
      );
    case 'list':
      return (
        <ul className="mod-ui__list" data-mod-node={node.id}>
          {node.items.map((item) => (
            <li key={`${item.label}-${item.value ?? ''}`}>
              <span>{item.label}</span>
              {item.value !== undefined ? <strong>{item.value}</strong> : null}
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <table className="mod-ui__table" data-mod-node={node.id}>
          <thead>
            <tr>
              {node.columns.map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {node.rows.map((row, rowIndex) => (
              <tr key={`row-${rowIndex}`}>
                {row.map((cell, cellIndex) => (
                  <td key={`cell-${rowIndex}-${cellIndex}`}>{cell}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
    case 'form':
      // A dedicated component, because the hook below must run on EVERY render of
      // a component that calls it. Calling it from inside this `case` would make
      // the hook order depend on which node kinds a mod contributed.
      return <FormNode node={node} backend={backend} />;
    default: {
      // An unknown node kind is ignored rather than rendered loosely: a future
      // node type must not fall through to something permissive.
      const exhaustive: never = node;
      void exhaustive;
      return null;
    }
  }
}

export function ModDeclarativeUi({ contribution, backend, onNotify }: ModDeclarativeUiProps) {
  const nodes = contribution.nodes.slice(0, MAX_UI_NODES);
  return (
    <div className="mod-ui" data-mod-slot={contribution.slot} data-mod-nodes={nodes.length}>
      {nodes.map((node, index) => (
        <Node key={nodeKey(node, index)} node={node} backend={backend} onNotify={onNotify} />
      ))}
    </div>
  );
}

export const MOD_UI_SLOTS: readonly ModUiSlot[] = ['statusBar', 'messageActions', 'sidePanel', 'settingsTab'];

/** Group contributions by slot so a host can render each slot in its own place. */
export function groupBySlot(contributions: readonly ModUiContribution[]): Map<ModUiSlot, ModUiContribution[]> {
  const grouped = new Map<ModUiSlot, ModUiContribution[]>();
  for (const contribution of contributions) {
    if (!MOD_UI_SLOTS.includes(contribution.slot)) continue;
    const bucket = grouped.get(contribution.slot) ?? [];
    bucket.push(contribution);
    grouped.set(contribution.slot, bucket);
  }
  return grouped;
}