import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Boxes, Plug, Sparkles } from 'lucide-react';
import type { McpServerStatus, McpTool } from '../../shared/ipc-types';
import type { Skill } from '../../shared/types';

const POLL_MS = 5000;

/** Shape returned by skills.listProposals; only the display fields are used. */
interface SkillProposalSummary {
  name: string;
  description: string;
  proposedBy: string;
  rationale?: string;
}

const statusClass = (status: McpServerStatus['status']): string => {
  if (status === 'connected') {
    return 'text-emerald-400';
  }
  if (status === 'connecting') {
    return 'text-amber-400';
  }
  if (status === 'failed') {
    return 'text-red-400';
  }
  return 'text-text-muted';
};

/**
 * Cowork 4.0 — Phase 7: skills and MCP visibility. Until now the enabled
 * skills, the pending proposals and the MCP servers were only reachable deep
 * inside the settings screens, so there was no single place to answer "what can
 * this agent actually use right now?". This pane is read-only on purpose:
 * approval stays in the Skill doctor, which is the only activation path.
 */
export function CapabilityPane() {
  const { t } = useTranslation();
  const skillsApi = typeof window !== 'undefined' ? window.electronAPI?.skills : undefined;
  const mcpApi = typeof window !== 'undefined' ? window.electronAPI?.mcp : undefined;
  const [skills, setSkills] = useState<Skill[]>([]);
  const [proposals, setProposals] = useState<SkillProposalSummary[]>([]);
  const [servers, setServers] = useState<McpServerStatus[]>([]);
  const [tools, setTools] = useState<McpTool[]>([]);
  const [storagePath, setStoragePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!skillsApi && !mcpApi) {
      return;
    }
    try {
      const [nextSkills, proposalResult, nextServers, nextTools, nextPath] = await Promise.all([
        skillsApi ? skillsApi.getAll() : Promise.resolve([] as Skill[]),
        skillsApi ? skillsApi.listProposals() : Promise.resolve({ success: false, proposals: [] }),
        mcpApi ? mcpApi.getServerStatus() : Promise.resolve([] as McpServerStatus[]),
        mcpApi ? mcpApi.getTools() : Promise.resolve([] as McpTool[]),
        skillsApi ? skillsApi.getStoragePath() : Promise.resolve(''),
      ]);
      setSkills(nextSkills);
      setProposals(proposalResult.success ? proposalResult.proposals : []);
      setServers(nextServers);
      setTools(nextTools);
      setStoragePath(nextPath.length > 0 ? nextPath : null);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [skillsApi, mcpApi]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const enabledSkills = skills.filter((skill) => skill.enabled);
  const disabledSkills = skills.filter((skill) => !skill.enabled);
  const connectedServers = servers.filter((server) => server.connected).length;

  const toolGroups = new Map<string, McpTool[]>();
  for (const tool of tools) {
    const key = tool.serverName.length > 0 ? tool.serverName : tool.serverId;
    const bucket = toolGroups.get(key);
    if (bucket) {
      bucket.push(tool);
    } else {
      toolGroups.set(key, [tool]);
    }
  }
  const groupedTools = Array.from(toolGroups.entries());

  return (
    <div className="flex flex-col gap-4">
      {!skillsApi && !mcpApi && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          {t('capabilityPanel.unavailable')}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      <p className="text-[11px] text-text-muted">{t('capabilityPanel.hint')}</p>

      <section className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
            <Boxes className="h-3 w-3" />
            {t('capabilityPanel.skills.title', { count: enabledSkills.length })}
          </h3>
          {storagePath && (
            <span className="truncate font-mono text-[10px] text-text-muted" title={storagePath}>
              {storagePath}
            </span>
          )}
        </div>
        <p className="text-[11px] text-text-muted">{t('capabilityPanel.skills.hint')}</p>
        {skills.length === 0 ? (
          <p className="text-xs text-text-muted">{t('capabilityPanel.skills.empty')}</p>
        ) : (
          <ul className="space-y-1.5">
            {enabledSkills.map((skill) => (
              <li
                key={skill.id}
                className="rounded-lg border border-border-subtle bg-background/60 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 truncate text-xs text-text-primary">{skill.name}</span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
                    {t('capabilityPanel.skillType.' + skill.type)}
                  </span>
                  <span className="text-[10px] text-emerald-400">
                    {t('capabilityPanel.skills.enabled')}
                  </span>
                </div>
                {skill.description && (
                  <p className="mt-1 text-[10px] text-text-muted">{skill.description}</p>
                )}
              </li>
            ))}
            {disabledSkills.map((skill) => (
              <li
                key={skill.id}
                className="rounded-lg border border-border-subtle bg-background/40 px-3 py-2 opacity-60"
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 truncate text-xs text-text-primary">{skill.name}</span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted">
                    {t('capabilityPanel.skillType.' + skill.type)}
                  </span>
                  <span className="text-[10px] text-text-muted">
                    {t('capabilityPanel.skills.disabled')}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <Sparkles className="h-3 w-3" />
          {t('capabilityPanel.proposals.title', { count: proposals.length })}
        </h3>
        {proposals.length === 0 ? (
          <p className="text-xs text-text-muted">{t('capabilityPanel.proposals.empty')}</p>
        ) : (
          <div className="space-y-1.5">
            <p className="text-[11px] text-text-muted">{t('capabilityPanel.proposals.hint')}</p>
            <ul className="space-y-1.5">
              {proposals.map((proposal) => (
                <li
                  key={proposal.name}
                  className="rounded-lg border border-accent/40 bg-accent/5 px-3 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="flex-1 truncate text-xs text-text-primary">
                      {proposal.name}
                    </span>
                    <span className="text-[10px] text-text-muted">{proposal.proposedBy}</span>
                  </div>
                  {proposal.rationale && (
                    <p className="mt-1 text-[10px] text-text-muted">{proposal.rationale}</p>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
          <Plug className="h-3 w-3" />
          {t('capabilityPanel.mcp.title', {
            connected: connectedServers,
            total: servers.length,
          })}
        </h3>
        {servers.length === 0 ? (
          <p className="text-xs text-text-muted">{t('capabilityPanel.mcp.empty')}</p>
        ) : (
          <ul className="space-y-1.5">
            {servers.map((server) => (
              <li
                key={server.id}
                className="rounded-lg border border-border-subtle bg-background/60 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <span className="flex-1 truncate text-xs text-text-primary">{server.name}</span>
                  <span className={'text-[10px] ' + statusClass(server.status)}>
                    {t('capabilityPanel.mcp.status.' + server.status)}
                  </span>
                  <span className="text-[10px] text-text-muted">
                    {t('capabilityPanel.mcp.toolCount', { count: server.toolCount })}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {groupedTools.length > 0 && (
        <section className="space-y-1.5">
          <h3 className="text-xs font-medium text-text-secondary">
            {t('capabilityPanel.mcp.tools')}
          </h3>
          <ul className="space-y-2">
            {groupedTools.map(([serverName, serverTools]) => (
              <li key={serverName}>
                <p className="text-[10px] text-text-muted">{serverName}</p>
                <ul className="mt-1 space-y-1">
                  {serverTools.map((tool) => (
                    <li
                      key={tool.name}
                      className="rounded border border-border-subtle bg-background/40 px-2 py-1"
                    >
                      <span className="font-mono text-[10px] text-text-primary">{tool.name}</span>
                      {tool.description && (
                        <span className="ml-2 text-[10px] text-text-muted">
                          {tool.description}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
