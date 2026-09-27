import { describe, expect, it } from 'vitest';
import { MessageRouter } from '../src/main/remote/message-router';
import type { RemoteResponse } from '../src/main/remote/types';

// Remote channels (Feishu/Slack/Lark) must never receive raw agent-protocol
// markup a degraded model leaked into its reply text.

const LEAKY_REPLY = `Réponse saine pour l'utilisateur distant.
<tool_use name="bash" id="call_remote">{"command":"pgrep -fl worker"}</tool_use>
<tool_result tool_use_id="call_remote">PID 42</tool_result>
Fin de la réponse.`;

interface RouterInternals {
  responseBuffers: Map<string, string>;
  responseCallback: ((response: RemoteResponse) => Promise<void>) | null;
  sendFinalResponse: (sessionId: string, originalMessage: never) => Promise<void>;
}

describe('MessageRouter.sendFinalResponse — protocol quarantine', () => {
  it('strips leaked protocol markup before forwarding to the channel', async () => {
    const router = new MessageRouter();
    const sent: RemoteResponse[] = [];
    const internals = router as unknown as RouterInternals;
    internals.responseCallback = async (response) => {
      sent.push(response);
    };
    internals.responseBuffers.set('sess-remote', LEAKY_REPLY);

    await internals.sendFinalResponse('sess-remote', {
      id: 'rm-1',
      channelType: 'slack',
      channelId: 'C1',
      sender: { id: 'u1', isBot: false },
      content: { type: 'text', text: 'run the build' },
      timestamp: 0,
      isGroup: false,
      isMentioned: true,
    } as never);

    expect(sent).toHaveLength(1);
    const markdown = (sent[0].content as { markdown: string }).markdown;
    expect(markdown).toContain('Réponse saine pour l\'utilisateur distant.');
    expect(markdown).toContain('Fin de la réponse.');
    expect(markdown).not.toContain('<tool_use');
    expect(markdown).not.toContain('PID 42');
  });

  it('sends nothing when the reply was pure raw protocol markup', async () => {
    const router = new MessageRouter();
    const sent: RemoteResponse[] = [];
    const internals = router as unknown as RouterInternals;
    internals.responseCallback = async (response) => {
      sent.push(response);
    };
    internals.responseBuffers.set(
      'sess-remote-2',
      '<turn role="assistant">\n<tool_use name="bash" id="x">{}</tool_use>\n</turn>'
    );

    await internals.sendFinalResponse('sess-remote-2', {
      id: 'rm-2',
      channelType: 'slack',
      channelId: 'C1',
      sender: { id: 'u1', isBot: false },
      content: { type: 'text', text: 'run the build' },
      timestamp: 0,
      isGroup: false,
      isMentioned: true,
    } as never);

    expect(sent).toHaveLength(0);
  });
});
