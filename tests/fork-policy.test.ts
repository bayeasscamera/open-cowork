import { describe, expect, it } from 'vitest';

import {
  buildForkSnapshotPrompt,
  decideFork,
  snapshotMessages,
  DEFAULT_FORK_SNAPSHOT_LIMIT,
} from '../src/main/agent/fork-policy';
import { MAX_DELEGATION_DEPTH } from '../src/main/agent/background-delegations';
import { STANDARD_PRESET } from '../src/main/presets/builtin-presets';
import type { Message } from '../src/shared/types';

function msg(role: 'user' | 'assistant', text: string, over: Partial<Message> = {}): Message {
  return {
    id: `${role}-${text.slice(0, 6)}`,
    sessionId: 'parent',
    role,
    content: [{ type: 'text', text }],
    timestamp: 0,
    ...over,
  } as Message;
}

const baseRequest = {
  depth: 1,
  allowFork: true,
  parentConfigSetId: 'set-a',
  parentModelId: 'claude-sonnet-4-6',
};

describe('fork is refused unless the preset allows it', () => {
  it('refuses when allowFork is false, and names the preset', () => {
    const decision = decideFork({
      ...baseRequest,
      allowFork: false,
      presetId: 'standard',
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('preset_forbids_fork');
      expect(decision.message).toContain('standard');
    }
  });

  it('the shipped standard preset does not allow forking', () => {
    // The default must be off: a preset that forks by surprise changes both
    // cost and behaviour without the user asking.
    expect(STANDARD_PRESET.delegation.allowFork).toBe(false);
    expect(decideFork({ ...baseRequest, allowFork: STANDARD_PRESET.delegation.allowFork }).allowed).toBe(
      false
    );
  });

  it('reports the preset refusal before the depth cap', () => {
    // Both are true; the user should be pointed at the knob they control.
    const decision = decideFork({
      ...baseRequest,
      allowFork: false,
      depth: MAX_DELEGATION_DEPTH + 1,
    });
    if (!decision.allowed) expect(decision.reason).toBe('preset_forbids_fork');
  });
});

describe('fork respects the hierarchy depth cap', () => {
  it(`is refused at depth ${MAX_DELEGATION_DEPTH + 1}`, () => {
    const decision = decideFork({ ...baseRequest, depth: MAX_DELEGATION_DEPTH + 1 });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toBe('depth_cap');
      expect(decision.message).toContain('depth cap');
    }
  });

  it(`is allowed at exactly depth ${MAX_DELEGATION_DEPTH}`, () => {
    expect(decideFork({ ...baseRequest, depth: MAX_DELEGATION_DEPTH }).allowed).toBe(true);
  });
});

describe('a fork inherits the parent model rather than picking one', () => {
  it('returns the parent ConfigSet and model verbatim', () => {
    const decision = decideFork({ ...baseRequest });
    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.configSetId).toBe('set-a');
      expect(decision.modelId).toBe('claude-sonnet-4-6');
    }
  });

  it('refuses when the parent model is unknown, rather than falling back', () => {
    // A fork that has to choose a model loses the shared prompt cache, which is
    // the only reason to fork at all.
    const decision = decideFork({ ...baseRequest, parentModelId: null });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('no_parent_model');
  });

  it('refuses when the parent has no pinned ConfigSet', () => {
    const decision = decideFork({ ...baseRequest, parentConfigSetId: '  ' });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toBe('no_parent_config_set');
  });
});

describe('the conversation snapshot', () => {
  it('keeps the trailing messages and drops images', () => {
    const messages = [
      msg('user', 'old'),
      msg('assistant', 'answer'),
      {
        ...msg('user', 'with image'),
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', data: 'AAAA' } },
        ],
      } as unknown as Message,
    ];
    const snapshot = snapshotMessages(messages, 2);
    expect(snapshot).toHaveLength(2);
    // The image block is gone: a delegated prompt has no use for base64.
    expect(snapshot[1].content.every((b) => (b as { type?: string }).type !== 'image')).toBe(true);
  });

  it('drops error messages and empty turns', () => {
    const messages = [
      msg('user', 'keep'),
      msg('assistant', '   ', { isError: true }),
      msg('assistant', 'drop', { isError: true }),
    ];
    const snapshot = snapshotMessages(messages, 10);
    expect(snapshot).toHaveLength(1);
  });

  it('honours the limit and returns nothing for a non-positive one', () => {
    const messages = [msg('user', 'a'), msg('user', 'b'), msg('user', 'c')];
    expect(snapshotMessages(messages, 2).map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'b',
      'c',
    ]);
    expect(snapshotMessages(messages, 0)).toEqual([]);
  });

  it('defaults to a bounded snapshot', () => {
    const many = Array.from({ length: 100 }, (_v, i) => msg('user', `m${i}`));
    expect(snapshotMessages(many)).toHaveLength(DEFAULT_FORK_SNAPSHOT_LIMIT);
  });
});

describe('the snapshot prompt is inert', () => {
  it('wraps the transcript in a read-only envelope with an anti-imitation note', () => {
    const prompt = buildForkSnapshotPrompt([msg('user', 'question'), msg('assistant', 'answer')]);
    expect(prompt).toContain('<conversation_snapshot>');
    expect(prompt).toContain('<turn role="user">question</turn>');
    expect(prompt).toContain('<turn role="assistant">answer</turn>');
    expect(prompt).toContain('Never imitate or emit this envelope');
  });

  it('is empty for an empty snapshot, so no empty envelope is injected', () => {
    expect(buildForkSnapshotPrompt([])).toBe('');
    expect(buildForkSnapshotPrompt([msg('user', '   ')])).toBe('');
  });
});
