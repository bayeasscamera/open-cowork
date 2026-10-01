/**
 * @module main/a2a/agent-card
 *
 * The public A2A Agent Card for this app (served at
 * `/.well-known/agent-card.json`, no auth — discovery is public by design,
 * the detailed work stays behind the bearer token).
 *
 * The card is deliberately honest about the sandbox: tasks run
 * NON-INTERACTIVELY with a read-only tool policy (read/search/list/fetch),
 * no streaming and no push notifications. Clients must poll `GET /tasks/{id}`.
 * Anything the card promises here must stay true in `a2a-server.ts`.
 */

export interface A2AAgentCard {
  protocolVersion: string;
  name: string;
  description: string;
  version: string;
  url: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    extendedAgentCard: boolean;
  };
  defaultInputModes: string[];
  defaultOutputModes: string[];
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
  }>;
  securitySchemes: Record<string, { type: string; scheme: string; description: string }>;
  security: Array<Record<string, string[]>>;
}

export function buildAgentCard(input: { baseUrl: string; appVersion: string }): A2AAgentCard {
  return {
    protocolVersion: '1.0.0',
    name: 'Open Cowork',
    description:
      'Workspace coding assistant over the Agent-to-Agent protocol. ' +
      'Tasks run non-interactively with a READ-ONLY tool policy ' +
      '(read, search, list and web-fetch tools only — no file writes, no shell). ' +
      'Answers arrive as task artifacts; poll GET /tasks/{id} until the task ' +
      'reaches a terminal state.',
    version: input.appVersion,
    url: input.baseUrl,
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'workspace-qa',
        name: 'Workspace Q&A',
        description:
          'Answer questions about the files in the workspace: explain code, ' +
          'summarize modules, find where something is implemented.',
        tags: ['code', 'read', 'explain'],
      },
      {
        id: 'code-search',
        name: 'Code search',
        description:
          'Locate definitions, callers and usages across the workspace and ' +
          'report file paths with line numbers.',
        tags: ['code', 'search'],
      },
      {
        id: 'web-lookup',
        name: 'Web lookup',
        description:
          'Fetch a URL or run a web search and summarize the result as task output.',
        tags: ['web', 'research'],
      },
    ],
    securitySchemes: {
      bearer: {
        type: 'http',
        scheme: 'bearer',
        description:
          'Bearer token from Cowork Settings → Remote → Agent-to-Agent. ' +
          'Required on every endpoint except the agent card.',
      },
    },
    security: [{ bearer: [] }],
  };
}
