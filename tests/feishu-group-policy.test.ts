/**
 * Feishu channel group policy tests.
 *
 * `FeishuChannelConfig.groups[chatId].requireMention` and
 * `defaultGroupSettings.requireMention` are settable from the channel settings,
 * but nothing read them: every group message without a mention was dropped, so
 * turning the requirement off silently did nothing.
 *
 * The policy is read here rather than in the gateway because the settings are
 * the channel's; the gateway only asks.
 */

import { describe, it, expect, vi } from 'vitest';
import { FeishuChannel } from '../src/main/remote/channels/feishu/feishu-channel';
import type { FeishuChannelConfig, RemoteMessage } from '../src/main/remote/types';

vi.mock('../src/main/utils/logger', () => ({
  log: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));

const CHAT = 'oc_group';
const USER = 'ou_user';

function makeChannel(overrides: Partial<FeishuChannelConfig> = {}): FeishuChannel {
  const config: FeishuChannelConfig = {
    type: 'feishu',
    appId: 'app-id',
    appSecret: 'app-secret',
    dm: { policy: 'open' },
    ...overrides,
  };
  return new FeishuChannel(config);
}

function groupMessage(overrides: Partial<RemoteMessage> = {}): RemoteMessage {
  return {
    id: 'msg-1',
    channelType: 'feishu',
    channelId: CHAT,
    sender: { id: USER, name: 'Alice', isBot: false },
    content: { type: 'text', text: 'bonjour' },
    timestamp: 1,
    isGroup: true,
    isMentioned: false,
    ...overrides,
  };
}

describe('FeishuChannel group policy', () => {
  it('stays silent when nothing is configured', () => {
    expect(makeChannel().shouldProcessUnmentionedGroupMessage(groupMessage())).toBe(false);
  });

  it('stays silent when the group asks for a mention, whatever the default says', () => {
    const channel = makeChannel({
      groups: { [CHAT]: { requireMention: true } },
      defaultGroupSettings: { requireMention: false },
    });
    expect(channel.shouldProcessUnmentionedGroupMessage(groupMessage())).toBe(false);
  });

  it('admits an unmentioned message when the group opts out of the mention', () => {
    const channel = makeChannel({ groups: { [CHAT]: { requireMention: false } } });
    expect(channel.shouldProcessUnmentionedGroupMessage(groupMessage())).toBe(true);
  });

  it('falls back to the default settings for a group with no entry of its own', () => {
    const channel = makeChannel({ defaultGroupSettings: { requireMention: false } });
    expect(channel.shouldProcessUnmentionedGroupMessage(groupMessage())).toBe(true);
  });

  it('narrows an opted-in group to its allowFrom list', () => {
    const channel = makeChannel({
      groups: { [CHAT]: { requireMention: false, allowFrom: ['ou_someone_else'] } },
    });

    expect(channel.shouldProcessUnmentionedGroupMessage(groupMessage())).toBe(false);
    expect(
      channel.shouldProcessUnmentionedGroupMessage(
        groupMessage({ sender: { id: 'ou_someone_else', name: 'Bob', isBot: false } })
      )
    ).toBe(true);
  });

  it('does not apply one group allowFrom to another group', () => {
    const channel = makeChannel({
      groups: { oc_other: { requireMention: false, allowFrom: ['ou_someone_else'] } },
      defaultGroupSettings: { requireMention: false },
    });

    // The default settings admit this chat, and the other group's allowFrom is
    // not consulted for it — otherwise one group's list would leak everywhere.
    expect(channel.shouldProcessUnmentionedGroupMessage(groupMessage())).toBe(true);
  });
});
