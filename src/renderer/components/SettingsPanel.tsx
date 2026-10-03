import { useCallback, useState, useEffect } from 'react';
import {
  X,
  Settings,
  Plug,
  Shield,
  ShieldAlert,
  Package,
  Clock3,
  Wifi,
  AlertCircle,
  Globe,
  Sparkles,
  BrainCircuit,
  Network,
  ExternalLink,
  Stethoscope,
  FolderCog,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useWindowSize } from '../hooks/useWindowSize';
import { RemoteControlPanel } from './RemoteControlPanel';
import { useAppStore } from '../store';
import { SettingsAPI } from './settings/SettingsAPI';
import { SettingsSandbox } from './settings/SettingsSandbox';
import { SettingsConnectors } from './settings/SettingsConnectors';
import { SettingsSkills } from './settings/SettingsSkills';
import { SettingsMods } from './settings/SettingsMods';
import { SettingsSchedule } from './settings/SettingsSchedule';
import { SettingsDiagnostics } from './settings/SettingsDiagnostics';
import { SettingsGeneral } from './settings/SettingsGeneral';
import { SettingsLogs } from './settings/SettingsLogs';
import { SettingsPresets } from './settings/SettingsPresets';
import { SettingsMemory } from './settings/SettingsMemory';
import { SettingsPersonalization } from './settings/SettingsPersonalization';
import { SettingsPermissions } from './settings/SettingsPermissions';
import { SettingsMachineAccess } from './settings/SettingsMachineAccess';

interface SettingsPanelProps {
  onClose: () => void;
  initialTab?:
    | 'api'
    | 'sandbox'
    | 'subagents'
    | 'connectors'
    | 'skills'
    | 'personalization'
    | 'memory'
    | 'schedule'
    | 'remote'
    | 'logs'
    | 'diagnostics'
    | 'permissions'
    | 'machineAccess'
    | 'general';
}

type TabId =
  | 'api'
  | 'sandbox'
  | 'subagents'
  | 'presets'
  | 'connectors'
  | 'skills'
  | 'personalization'
  | 'memory'
  | 'schedule'
  | 'remote'
  | 'logs'
  | 'diagnostics'
  | 'permissions'
  | 'machineAccess'
  | 'general';

const VALID_TABS = new Set<TabId>([
  'api',
  'sandbox',
  'subagents',
  'presets',
  'connectors',
  'skills',
  'personalization',
  'memory',
  'schedule',
  'remote',
  'logs',
  'diagnostics',
  'permissions',
  'machineAccess',
  'general',
]);

interface TabGroup {
  labelKey: string;
  tabs: TabId[];
}

/** Global emergency-stop shortcut, shown next to the button. */
const EMERGENCY_STOP_SHORTCUT = 'CmdOrCtrl+Shift+.';

const TAB_GROUPS: TabGroup[] = [
  { labelKey: 'settings.groupModel', tabs: ['api', 'sandbox', 'subagents', 'presets'] },
  { labelKey: 'settings.groupExtensions', tabs: ['connectors', 'skills'] },
  { labelKey: 'settings.groupPersonal', tabs: ['personalization', 'memory'] },
  { labelKey: 'settings.groupAutomation', tabs: ['schedule', 'remote'] },
  { labelKey: 'settings.groupSystem', tabs: ['diagnostics', 'logs', 'permissions', 'machineAccess', 'general'] },
];

/**
 * Settings keeps a single ENTRY POINT to the Sub-agents interface, but the
 * interface itself lives in the dedicated sidebar view (same navigation level
 * as the Projects pages). Rendering the component here as well is what created
 * two drifted surfaces; this panel only navigates.
 */
function SubAgentsLinkPanel({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4 rounded-2xl border border-border-muted bg-surface/60 p-6 sm:flex-row sm:items-center sm:justify-between">
      <p className="max-w-[34rem] text-sm text-text-muted">{t('settings.subAgentsMovedDesc')}</p>
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex flex-shrink-0 items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90"
      >
        <ExternalLink className="h-4 w-4" />
        {t('settings.subAgentsOpenView')}
      </button>
    </div>
  );
}

/**
 * Connects the machine-access panel to the store and the real IPC surface.
 * Kept as a container so the panel itself stays a pure view, and so the
 * emergency stop is reachable from one place only.
 */
function MachineAccessSection({ isActive }: { isActive: boolean }) {
  const { t } = useTranslation();
  const state = useAppStore((s) => s.machineAccess);
  const loading = useAppStore((s) => s.machineAccessLoading);
  const error = useAppStore((s) => s.machineAccessError);
  const loadMachineAccess = useAppStore((s) => s.loadMachineAccess);
  const addMachineAccessGrant = useAppStore((s) => s.addMachineAccessGrant);
  const revokeMachineAccessGrant = useAppStore((s) => s.revokeMachineAccessGrant);
  const setMachineAccessAutonomy = useAppStore((s) => s.setMachineAccessAutonomy);
  const addMachineAccessApp = useAppStore((s) => s.addMachineAccessApp);
  const removeMachineAccessApp = useAppStore((s) => s.removeMachineAccessApp);
  const undoMachineAccessBatch = useAppStore((s) => s.undoMachineAccessBatch);
  const machineAccessEmergencyStop = useAppStore((s) => s.machineAccessEmergencyStop);

  useEffect(() => {
    if (isActive) void loadMachineAccess();
  }, [isActive, loadMachineAccess]);

  if (loading && state.grants.length === 0) {
    return <p className="text-sm text-text-muted">{t('machineAccess.loading')}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {!state.nativeMode && (
        <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-500">
          {t('machineAccess.inactiveMode')}
        </p>
      )}
      {error && (
        <p className="rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-xs text-danger">
          {error}
        </p>
      )}
      <SettingsMachineAccess
        grants={state.grants}
        autonomy={state.autonomy}
        allowedApps={state.allowedApps}
        permissions={state.permissions}
        history={state.history}
        onAddGrant={() => void addMachineAccessGrant()}
        onRevokeGrant={(id) => void revokeMachineAccessGrant(id)}
        onChangeAutonomy={(level) => void setMachineAccessAutonomy(level)}
        onAddApp={() => void addMachineAccessApp(window.prompt(t('machineAccess.appNamePrompt')) ?? '')}
        onRemoveApp={(name) => void removeMachineAccessApp(name)}
        onUndoBatch={(batchId) => void undoMachineAccessBatch(batchId)}
        onEmergencyStop={() => void machineAccessEmergencyStop()}
        emergencyShortcut={EMERGENCY_STOP_SHORTCUT}
      />
    </div>
  );
}

export function SettingsPanel({ onClose, initialTab = 'api' }: SettingsPanelProps) {
  const { t } = useTranslation();
  const { width } = useWindowSize();
  const compactSidebar = width < 900;
  // Read settingsTab from store at mount time so external navigation (nav-server)
  // takes effect even before this component mounts.
  const storeTab = useAppStore((s) => s.settingsTab);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const setSubAgentsVisible = useAppStore((s) => s.setSubAgentsVisible);
  const resolvedInitial =
    storeTab && VALID_TABS.has(storeTab as TabId) ? (storeTab as TabId) : initialTab;

  const [activeTab, setActiveTab] = useState<TabId>(resolvedInitial);
  // Track which tabs have been viewed at least once (for lazy loading)
  const [viewedTabs, setViewedTabs] = useState<Set<TabId>>(new Set([resolvedInitial]));
  const [appVersion, setAppVersion] = useState('');
  useEffect(() => {
    try {
      const v = window.electronAPI?.getVersion?.();
      if (v instanceof Promise) v.then(setAppVersion);
      else if (v) setAppVersion(v);
    } catch {
      /* ignore */
    }
  }, []);

  // Consume the store signal and apply tab in one effect
  useEffect(() => {
    if (storeTab && VALID_TABS.has(storeTab as TabId)) {
      setActiveTab(storeTab as TabId);
      setSettingsTab(null);
    }
  }, [storeTab, setSettingsTab]);

  // Mark tab as viewed when it becomes active
  useEffect(() => {
    if (!viewedTabs.has(activeTab)) {
      setViewedTabs((prev) => new Set([...prev, activeTab]));
    }
    // Intentionally keyed on activeTab only: setViewedTabs uses the functional
    // form, so reading viewedTabs here would re-trigger on every set.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  /** Settings only links to the dedicated view; it never hosts the interface. */
  const openSubAgentsView = useCallback((): void => {
    setSubAgentsVisible(true);
    onClose();
  }, [setSubAgentsVisible, onClose]);

  const tabs = [
    {
      id: 'api' as TabId,
      label: t('settings.apiSettings'),
      icon: Settings,
      description: t('settings.apiSettingsDesc'),
    },
    {
      id: 'sandbox' as TabId,
      label: t('settings.sandbox'),
      icon: Shield,
      description: t('settings.sandboxDesc'),
    },
    {
      id: 'subagents' as TabId,
      label: t('settings.subAgents'),
      icon: Network,
      description: t('settings.subAgentsDesc'),
    },
    {
      id: 'presets' as TabId,
      label: t('settings.presets'),
      icon: Network,
      description: t('settings.presetsDesc'),
    },
    {
      id: 'connectors' as TabId,
      label: t('settings.connectors'),
      icon: Plug,
      description: t('settings.connectorsDesc'),
    },
    {
      id: 'skills' as TabId,
      label: t('settings.skills'),
      icon: Package,
      description: t('settings.skillsDesc'),
    },
    {
      id: 'personalization' as TabId,
      label: t('settings.personalization'),
      icon: Sparkles,
      description: t('settings.personalizationDesc'),
    },
    {
      id: 'memory' as TabId,
      label: t('settings.memory'),
      icon: BrainCircuit,
      description: t('settings.memoryDesc'),
    },
    {
      id: 'schedule' as TabId,
      label: t('settings.schedule'),
      icon: Clock3,
      description: t('settings.scheduleDesc'),
    },
    {
      id: 'remote' as TabId,
      label: t('settings.remote', '远程控制'),
      icon: Wifi,
      description: t('settings.remoteDesc', '通过飞书等平台远程使用'),
    },
    {
      id: 'logs' as TabId,
      label: t('settings.logs'),
      icon: AlertCircle,
      description: t('settings.logsDesc'),
    },
    {
      id: 'general' as TabId,
      label: t('settings.general'),
      icon: Globe,
      description: t('settings.generalDesc'),
    },
    {
      id: 'diagnostics' as TabId,
      label: t('settings.diagnostics'),
      icon: Stethoscope,
      description: t('settings.diagnosticsDesc'),
    },
    {
      id: 'permissions' as TabId,
      label: t('settings.permissions'),
      icon: ShieldAlert,
      description: t('settings.permissionsDesc'),
    },
    {
      id: 'machineAccess' as TabId,
      label: t('settings.machineAccess'),
      icon: FolderCog,
      description: t('settings.machineAccessDesc'),
    },
  ];
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]));
  const activeTabMeta = tabsById.get(activeTab);
  const activeGroupLabel = TAB_GROUPS.find((group) => group.tabs.includes(activeTab));

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      {/* Sidebar */}
      <div
        className={`${compactSidebar ? 'w-14' : 'w-56 lg:w-64'} panel-glass border-r border-border-muted flex flex-col flex-shrink-0`}
      >
        {!compactSidebar && (
          <div className="px-5 pt-6 pb-5">
            <p className="group-eyebrow">{t('settings.title')}</p>
            <h2 className="mt-1.5 text-[1.3rem] font-semibold tracking-[-0.03em] text-text-primary">
              Open Cowork
            </h2>
            <div className="accent-underline mt-2 w-10" />
          </div>
        )}
        <div
          className={`flex-1 overflow-y-auto ${compactSidebar ? 'p-1.5 space-y-1' : 'px-3 pb-3 space-y-4'}`}
        >
          {TAB_GROUPS.map((group) => {
            const groupTabs = group.tabs
              .map((id) => tabsById.get(id))
              .filter((tab): tab is (typeof tabs)[number] => Boolean(tab));
            if (groupTabs.length === 0) return null;
            const groupIsActive = group.tabs.includes(activeTab);
            return (
              <div key={group.labelKey} className="space-y-1">
                {!compactSidebar && (
                  <p
                    className={`group-eyebrow px-2 pt-3 pb-1 transition-colors ${
                      groupIsActive ? 'text-accent' : ''
                    }`}
                  >
                    {t(group.labelKey)}
                  </p>
                )}
                <div className="space-y-1">
                  {groupTabs.map((tab) => {
                    const isActive = activeTab === tab.id;
                    return (
                      <button
                        key={tab.id}
                        onClick={() => setActiveTab(tab.id)}
                        title={compactSidebar ? tab.label : undefined}
                        aria-current={isActive ? 'page' : undefined}
                        className={`relative w-full flex items-center rounded-xl text-left transition-all duration-150 active:scale-[0.98] ${
                          compactSidebar ? 'justify-center p-2.5' : 'gap-3 px-2.5 py-2.5'
                        } ${
                          isActive
                            ? 'bg-accent/10 text-text-primary'
                            : 'text-text-secondary hover:bg-surface-hover/60 hover:text-text-primary'
                        }`}
                      >
                        {isActive && (
                          <span
                            aria-hidden="true"
                            className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full bg-accent shadow-glow-accent"
                          />
                        )}
                        <span
                          className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg transition-colors ${
                            isActive
                              ? 'bg-accent/15 text-accent'
                              : 'bg-surface-muted/70 text-text-muted'
                          }`}
                        >
                          <tab.icon className="w-4 h-4" />
                        </span>
                        {!compactSidebar && (
                          <span className="flex-1 min-w-0">
                            <span
                              className={`block text-sm truncate ${isActive ? 'font-medium' : ''}`}
                            >
                              {tab.label}
                            </span>
                            <span className="block text-[11px] leading-4 text-text-muted truncate mt-0.5">
                              {tab.description}
                            </span>
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
        <div className={`${compactSidebar ? 'p-1.5' : 'p-4'} border-t border-border-muted`}>
          <button
            onClick={onClose}
            className={`w-full py-2 ${compactSidebar ? 'px-2' : 'px-4'} rounded-lg bg-background hover:bg-surface-hover transition-colors text-text-secondary text-sm`}
            title={compactSidebar ? t('common.close') : undefined}
          >
            {compactSidebar ? <X className="w-4 h-4 mx-auto" /> : t('common.close')}
          </button>
          {!compactSidebar && (
            <p className="text-[10px] text-text-muted text-center mt-2 select-text">
              v{appVersion}
            </p>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 flex flex-col overflow-hidden min-w-0">
        <>
          <div className="flex items-center justify-between px-4 lg:px-8 py-4 border-b border-border-muted flex-shrink-0 panel-glass">
            <div>
              <p className="text-[11px] text-text-muted">
                {t('settings.title')}
                {activeGroupLabel && <> › {t(activeGroupLabel.labelKey)}</>}
              </p>
              <h3 className="mt-1 text-[1.3rem] font-semibold tracking-[-0.03em] text-text-primary">
                {activeTabMeta?.label}
              </h3>
              <div className="accent-underline mt-1.5 w-14" />
              {activeTabMeta?.description && (
                <p className="mt-2 text-sm text-text-muted max-w-[36rem]">
                  {activeTabMeta.description}
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-lg hover:bg-surface-hover transition-colors"
            >
              <X className="w-5 h-5 text-text-secondary" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-6 lg:px-8 lg:py-8">
            <div className="max-w-[860px] w-full min-w-0 mx-auto">
              <div className="">
                <div className={activeTab === 'subagents' ? '' : 'hidden'}>
                  {viewedTabs.has('subagents') && <SubAgentsLinkPanel onOpen={openSubAgentsView} />}
                </div>
                <div className={activeTab === 'api' ? '' : 'hidden'}>
                  {viewedTabs.has('api') && (
                    <>
                      <SettingsAPI />
                    </>
                  )}
                </div>
                <div className={activeTab === 'sandbox' ? '' : 'hidden'}>
                  {viewedTabs.has('sandbox') && <SettingsSandbox />}
                </div>
                <div className={activeTab === 'connectors' ? '' : 'hidden'}>
                  {viewedTabs.has('connectors') && (
                    <SettingsConnectors isActive={activeTab === 'connectors'} />
                  )}
                </div>
                <div className={activeTab === 'skills' ? '' : 'hidden'}>
                  <SettingsMods />
                  {viewedTabs.has('skills') && <SettingsSkills isActive={activeTab === 'skills'} />}
                </div>
                <div className={activeTab === 'personalization' ? '' : 'hidden'}>
                  {viewedTabs.has('personalization') && <SettingsPersonalization />}
                </div>
                <div className={activeTab === 'memory' ? '' : 'hidden'}>
                  {viewedTabs.has('memory') && <SettingsMemory />}
                </div>
                <div className={activeTab === 'schedule' ? '' : 'hidden'}>
                  {viewedTabs.has('schedule') && (
                    <SettingsSchedule isActive={activeTab === 'schedule'} />
                  )}
                </div>
                <div className={activeTab === 'remote' ? '' : 'hidden'}>
                  {viewedTabs.has('remote') && (
                    <RemoteControlPanel isActive={activeTab === 'remote'} />
                  )}
                </div>
                <div className={activeTab === 'presets' ? '' : 'hidden'}>
                  {viewedTabs.has('presets') && <SettingsPresets isActive={activeTab === 'presets'} />}
                </div>
                <div className={activeTab === 'logs' ? '' : 'hidden'}>
                  {viewedTabs.has('logs') && <SettingsLogs isActive={activeTab === 'logs'} />}
                </div>
                <div className={activeTab === 'general' ? '' : 'hidden'}>
                  {viewedTabs.has('general') && <SettingsGeneral />}
                </div>
                <div className={activeTab === 'diagnostics' ? '' : 'hidden'}>
                  {viewedTabs.has('diagnostics') && (
                    <SettingsDiagnostics isActive={activeTab === 'diagnostics'} />
                  )}
                </div>
                <div className={activeTab === 'permissions' ? '' : 'hidden'}>
                  {viewedTabs.has('permissions') && (
                    <SettingsPermissions isActive={activeTab === 'permissions'} />
                  )}
                </div>
                <div className={activeTab === 'machineAccess' ? '' : 'hidden'}>
                  {viewedTabs.has('machineAccess') && (
                    <MachineAccessSection isActive={activeTab === 'machineAccess'} />
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      </div>
    </div>
  );
}
