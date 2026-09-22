import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  FileCode,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  MessageSquare,
  Plus,
  Save,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import type { Project, Session } from '../types';
import { useAppStore } from '../store';
import { buildConfigSetLites, ConfigSetModelPicker } from './shared/ConfigSetModelPicker';

/**
 * Projects editor modal — creation and detail/edit of a Project.
 * A project binds a workspace folder, persistent instructions, reference
 * files and an optional ConfigSet; sessions started while the project is
 * active inherit that context (injected by the main process at session start).
 *
 * The editor is organised in labelled sections with inline validation,
 * character counters and keyboard shortcuts (Esc to close, ⌘/Ctrl+Enter to save).
 */

const STATUS_LABEL: Record<Session['status'], string> = {
  idle: 'projects.statusIdle',
  running: 'projects.statusRunning',
  completed: 'projects.statusCompleted',
  error: 'projects.statusError',
};

const STATUS_TONE: Record<Session['status'], string> = {
  idle: 'bg-text-muted',
  running: 'bg-accent animate-pulse',
  completed: 'bg-success',
  error: 'bg-error',
};

function isAbsolutePath(value: string): boolean {
  return /^([a-zA-Z]:[\\/]|\/)/.test(value.trim());
}

function isImagePath(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext);
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function FileIcon({ path, className }: { path: string; className?: string }) {
  if (isImagePath(path)) return <ImageIcon className={className} />;
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  if (
    [
      'ts',
      'tsx',
      'js',
      'jsx',
      'py',
      'rs',
      'go',
      'java',
      'c',
      'cpp',
      'h',
      'sh',
      'json',
      'yaml',
      'yml',
      'toml',
      'sql',
      'css',
      'html',
    ].includes(ext)
  ) {
    return <FileCode className={className} />;
  }
  return <FileText className={className} />;
}

function FieldLabel({
  children,
  required,
  hint,
}: {
  children: ReactNode;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <label className="block text-xs font-medium text-text-secondary">
        {children}
        {required && <span className="ml-1 text-accent">*</span>}
      </label>
      {hint && <span className="text-[10px] text-text-muted">{hint}</span>}
    </div>
  );
}

function SectionCard({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-card p-4">
      <div className="mb-3 flex items-start gap-2.5">
        <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-accent/12 text-accent">
          {icon}
        </span>
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold text-text-primary">{title}</h3>
          {description && (
            <p className="mt-0.5 text-[11px] leading-4 text-text-muted">{description}</p>
          )}
        </div>
      </div>
      {children}
    </section>
  );
}

export function ProjectsPanel() {
  const { t } = useTranslation();
  const showProjectsModal = useAppStore((s) => s.showProjectsModal);
  const projectsModalProjectId = useAppStore((s) => s.projectsModalProjectId);
  const closeProjectsModal = useAppStore((s) => s.closeProjectsModal);
  const setProjects = useAppStore((s) => s.setProjects);
  const appConfig = useAppStore((s) => s.appConfig);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [workdir, setWorkdir] = useState('');
  const [configSetId, setConfigSetId] = useState('');
  const [configModelId, setConfigModelId] = useState('');
  const [instructions, setInstructions] = useState('');
  const [referenceFiles, setReferenceFiles] = useState<string[]>([]);
  const [archived, setArchived] = useState(false);
  const [sessions, setSessions] = useState<
    Array<{ id: string; title: string; status: string; updated_at: number }>
  >([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [touched, setTouched] = useState<{ name: boolean; workdir: boolean }>({
    name: false,
    workdir: false,
  });

  const isEdit = projectsModalProjectId !== null;

  const refreshProjectsList = useCallback(async () => {
    try {
      const result = await window.electronAPI.projects.list(true);
      if (result.success) setProjects(result.projects);
    } catch {
      // Non-fatal: sidebar keeps whatever it has.
    }
  }, [setProjects]);

  const loadProject = useCallback(
    async (projectId: string) => {
      setIsLoading(true);
      setError(null);
      try {
        const result = await window.electronAPI.projects.get(projectId);
        if (!result.success || !result.project) {
          setError(result.error || t('projects.errors.loadFailed'));
          return;
        }
        const project: Project = result.project;
        setName(project.name);
        setDescription(project.description ?? '');
        setWorkdir(project.workdir);
        setConfigSetId(project.configSetId ?? '');
        setConfigModelId(project.modelId ?? '');
        setInstructions(project.instructions ?? '');
        setReferenceFiles(project.referenceFiles);
        setArchived(project.archived);
        setSessions(result.sessions ?? []);
      } catch (err) {
        setError(err instanceof Error ? err.message : t('projects.errors.loadFailed'));
      } finally {
        setIsLoading(false);
      }
    },
    [t]
  );

  useEffect(() => {
    if (!showProjectsModal) return;
    setConfirmDelete(false);
    setTouched({ name: false, workdir: false });
    if (isEdit && projectsModalProjectId) {
      void loadProject(projectsModalProjectId);
    } else {
      // Create mode: reset the form.
      setName('');
      setDescription('');
      setWorkdir('');
      setConfigSetId('');
      setConfigModelId('');
      setInstructions('');
      setReferenceFiles([]);
      setArchived(false);
      setSessions([]);
      setError(null);
    }
  }, [showProjectsModal, isEdit, projectsModalProjectId, loadProject]);

  const handleSelectWorkdir = async () => {
    try {
      const folder = await window.electronAPI.invoke<string | null>({
        type: 'folder.select',
        payload: {},
      });
      if (folder) {
        setWorkdir(folder);
        setTouched((prev) => ({ ...prev, workdir: true }));
      }
    } catch {
      // dialog cancelled — keep current value
    }
  };

  const handleAttachFiles = async () => {
    try {
      const paths = await window.electronAPI.selectFiles();
      if (!projectsModalProjectId) return; // only in edit mode (files persist server-side)
      for (const filePath of paths) {
        const result = await window.electronAPI.projects.attachFile(
          projectsModalProjectId,
          filePath
        );
        if (!result.success) {
          setError(result.error || t('projects.errors.attachFailed'));
          return;
        }
        if (result.project) setReferenceFiles(result.project.referenceFiles);
      }
      void refreshProjectsList();
    } catch {
      // dialog cancelled
    }
  };

  const handleDetachFile = async (filePath: string) => {
    if (!projectsModalProjectId) return;
    try {
      const result = await window.electronAPI.projects.detachFile(projectsModalProjectId, filePath);
      if (!result.success) {
        setError(result.error || t('projects.errors.detachFailed'));
        return;
      }
      if (result.project) setReferenceFiles(result.project.referenceFiles);
      void refreshProjectsList();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('projects.errors.detachFailed'));
    }
  };

  const nameInvalid = !name.trim();
  const workdirInvalid = !workdir.trim() || !isAbsolutePath(workdir);

  const handleSave = async () => {
    setError(null);
    setTouched({ name: true, workdir: true });
    if (nameInvalid || workdirInvalid) {
      setError(t('projects.errors.nameAndWorkdirRequired'));
      return;
    }
    setIsSaving(true);
    try {
      if (isEdit && projectsModalProjectId) {
        const result = await window.electronAPI.projects.update({
          projectId: projectsModalProjectId,
          name: name.trim(),
          description: description.trim() || null,
          workdir: workdir.trim(),
          configSetId: configSetId || null,
          modelId: configModelId || null,
          instructions: instructions.trim() || null,
        });
        if (!result.success) {
          setError(result.error || t('projects.errors.saveFailed'));
          return;
        }
      } else {
        const result = await window.electronAPI.projects.create({
          name: name.trim(),
          workdir: workdir.trim(),
          description: description.trim() || undefined,
          configSetId: configSetId || undefined,
          modelId: configModelId || undefined,
          instructions: instructions.trim() || undefined,
        });
        if (!result.success) {
          setError(result.error || t('projects.errors.saveFailed'));
          return;
        }
      }
      await refreshProjectsList();
      closeProjectsModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('projects.errors.saveFailed'));
    } finally {
      setIsSaving(false);
    }
  };

  // Esc closes the editor, ⌘/Ctrl+Enter saves — the modal is a form, it should
  // behave like one.
  useEffect(() => {
    if (!showProjectsModal) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeProjectsModal();
      } else if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const handleArchiveToggle = async () => {
    if (!projectsModalProjectId) return;
    try {
      const result = await window.electronAPI.projects.archive(projectsModalProjectId, !archived);
      if (!result.success) {
        setError(result.error || t('projects.errors.archiveFailed'));
        return;
      }
      setArchived(!archived);
      setConfirmDelete(false);
      void refreshProjectsList();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('projects.errors.archiveFailed'));
    }
  };

  const handleDelete = async () => {
    if (!projectsModalProjectId) return;
    setIsDeleting(true);
    setError(null);
    try {
      // The backend keeps its double-security invariant: permanent delete
      // works only on ARCHIVED projects. From a still-active project, the
      // confirmed delete archives it first.
      if (!archived) {
        const archiveResult = await window.electronAPI.projects.archive(
          projectsModalProjectId,
          true
        );
        if (!archiveResult.success) {
          setError(archiveResult.error || t('projects.errors.archiveFailed'));
          return;
        }
      }
      const result = await window.electronAPI.projects.delete(projectsModalProjectId);
      if (!result.success) {
        setError(result.error || t('projects.errors.deleteFailed'));
        return;
      }
      // Never leave the sidebar filter pointing at a deleted project.
      if (useAppStore.getState().activeProjectId === projectsModalProjectId) {
        useAppStore.getState().setActiveProjectId(null);
      }
      await refreshProjectsList();
      closeProjectsModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('projects.errors.deleteFailed'));
    } finally {
      setIsDeleting(false);
    }
  };

  if (!showProjectsModal) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-md"
      onClick={closeProjectsModal}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? t('projects.editTitle') : t('projects.newTitle')}
      >
        <div className="flex items-center justify-between border-b border-border-muted px-6 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-accent/12 text-accent">
              <FolderOpen className="h-4 w-4" />
            </span>
            <div>
              <h2 className="text-[15px] font-semibold text-text-primary">
                {isEdit ? t('projects.editTitle') : t('projects.newTitle')}
              </h2>
              <p className="text-[11px] text-text-muted">{t('projects.workdirHint')}</p>
            </div>
          </div>
          <button
            onClick={closeProjectsModal}
            className="flex h-8 w-8 items-center justify-center rounded-xl text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
          {isLoading ? (
            <div className="flex items-center gap-2 py-8 text-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm">{t('projects.loading')}</span>
            </div>
          ) : (
            <>
              <SectionCard
                icon={<FolderOpen className="h-3.5 w-3.5" />}
                title={t('projects.name')}
                description={t('projects.descriptionPlaceholder')}
              >
                <div className="space-y-3">
                  <div>
                    <FieldLabel required>{t('projects.name')}</FieldLabel>
                    <input
                      type="text"
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value);
                        setTouched((prev) => ({ ...prev, name: true }));
                      }}
                      placeholder={t('projects.namePlaceholder')}
                      className={`w-full rounded-xl border bg-surface px-3 py-2 text-[13px] text-text-primary focus:outline-none ${
                        touched.name && nameInvalid
                          ? 'border-error focus:border-error'
                          : 'border-border focus:border-accent'
                      }`}
                    />
                    {touched.name && nameInvalid && (
                      <p className="mt-1 text-[11px] text-error">{t('projects.requiredField')}</p>
                    )}
                  </div>

                  <div>
                    <FieldLabel>{t('projects.description')}</FieldLabel>
                    <input
                      type="text"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder={t('projects.descriptionPlaceholder')}
                      className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-[13px] text-text-primary focus:border-accent focus:outline-none"
                    />
                  </div>
                </div>
              </SectionCard>

              <SectionCard
                icon={<FolderOpen className="h-3.5 w-3.5" />}
                title={t('projects.workdir')}
                description={t('projects.workdirHint')}
              >
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={workdir}
                    onChange={(e) => {
                      setWorkdir(e.target.value);
                      setTouched((prev) => ({ ...prev, workdir: true }));
                    }}
                    placeholder={t('projects.workdirPlaceholder')}
                    className={`flex-1 rounded-xl border bg-surface px-3 py-2 font-mono text-[12px] text-text-primary focus:outline-none ${
                      touched.workdir && workdirInvalid
                        ? 'border-error focus:border-error'
                        : 'border-border focus:border-accent'
                    }`}
                  />
                  <button
                    onClick={handleSelectWorkdir}
                    className="flex items-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-[13px] text-text-primary transition-colors hover:bg-surface-hover"
                    title={t('projects.browse')}
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    <span>{t('projects.browse')}</span>
                  </button>
                </div>
                {touched.workdir && workdirInvalid && (
                  <p className="mt-1 text-[11px] text-error">
                    {workdir.trim() ? t('projects.workdirInvalid') : t('projects.requiredField')}
                  </p>
                )}
              </SectionCard>

              <SectionCard
                icon={<Settings2 className="h-3.5 w-3.5" />}
                title={t('projects.configSet')}
                description={t('projects.configSetHint')}
              >
                <ConfigSetModelPicker
                  sets={buildConfigSetLites(appConfig ?? {})}
                  value={{ configSetId: configSetId, modelId: configModelId || undefined }}
                  onChange={(next) => {
                    setConfigSetId(next.configSetId);
                    setConfigModelId(next.modelId ?? '');
                  }}
                  configSetLabel={t('projects.configSetShort')}
                  modelLabel={t('projects.model')}
                  allowEmpty
                  emptyLabel={t('projects.configSetNone')}
                />
              </SectionCard>

              <SectionCard
                icon={<Sparkles className="h-3.5 w-3.5" />}
                title={t('projects.instructions')}
                description={t('projects.instructionsHint')}
              >
                <textarea
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder={t('projects.instructionsPlaceholder')}
                  rows={6}
                  className="w-full resize-y rounded-xl border border-border bg-surface px-3 py-2 text-[13px] text-text-primary focus:border-accent focus:outline-none"
                />
                <p className="mt-1 text-right text-[10px] tabular-nums text-text-muted">
                  {t('projects.characters', { count: instructions.length })}
                </p>
              </SectionCard>

              <SectionCard
                icon={<FileText className="h-3.5 w-3.5" />}
                title={t('projects.referenceFiles')}
                description={isEdit ? undefined : t('projects.attachAfterCreate')}
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11px] text-text-muted">
                    {t('projects.fileCount', { count: referenceFiles.length })}
                  </span>
                  {isEdit && (
                    <button
                      onClick={handleAttachFiles}
                      className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
                    >
                      <Plus className="h-3 w-3" />
                      <span>{t('projects.attachFile')}</span>
                    </button>
                  )}
                </div>
                {referenceFiles.length === 0 ? (
                  <p className="text-[12px] text-text-muted">{t('projects.noReferenceFiles')}</p>
                ) : (
                  <ul className="space-y-1">
                    {referenceFiles.map((filePath) => (
                      <li
                        key={filePath}
                        className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5"
                        title={filePath}
                      >
                        <FileIcon
                          path={filePath}
                          className="h-3.5 w-3.5 flex-shrink-0 text-text-muted"
                        />
                        <span className="min-w-0 flex-1 truncate text-[12px] text-text-primary">
                          {fileName(filePath)}
                        </span>
                        <span className="hidden max-w-[40%] truncate text-[10px] text-text-muted sm:block">
                          {filePath}
                        </span>
                        {isEdit && (
                          <button
                            onClick={() => handleDetachFile(filePath)}
                            className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-lg text-text-muted transition-colors hover:bg-surface-hover hover:text-error"
                            title={t('projects.removeFile')}
                            aria-label={t('projects.removeFile')}
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </SectionCard>

              {isEdit && sessions.length > 0 && (
                <SectionCard
                  icon={<MessageSquare className="h-3.5 w-3.5" />}
                  title={`${t('projects.sessions')} (${sessions.length})`}
                >
                  <ul className="max-h-48 space-y-1 overflow-y-auto">
                    {sessions.map((session) => (
                      <li
                        key={session.id}
                        onClick={() => {
                          useAppStore.getState().setActiveSession(session.id);
                          closeProjectsModal();
                        }}
                        className="flex cursor-pointer items-center gap-2 rounded-lg bg-surface px-2.5 py-1.5 transition-colors hover:bg-surface-hover"
                      >
                        <span
                          className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${
                            STATUS_TONE[session.status as Session['status']] ?? 'bg-text-muted'
                          }`}
                          title={t(
                            STATUS_LABEL[session.status as Session['status']] ??
                              'projects.statusIdle'
                          )}
                        />
                        <span className="min-w-0 flex-1 truncate text-[12px] text-text-primary">
                          {session.title}
                        </span>
                        <span className="flex-shrink-0 text-[11px] text-text-muted">
                          {session.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                </SectionCard>
              )}

              {error && (
                <p className="text-[12px] text-error" role="alert">
                  {error}
                </p>
              )}

              {isEdit && (
                <div className="rounded-xl border border-error/30 bg-error/10 px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[12px] font-semibold text-error">
                    <AlertTriangle className="h-3.5 w-3.5" />
                    <span>{t('projects.dangerZoneTitle')}</span>
                  </div>
                  <p className="mt-1 text-[11px] leading-4 text-text-muted">
                    {t('projects.dangerZoneHint')}
                  </p>
                  {confirmDelete ? (
                    <>
                      <p className="mt-2 text-[12px] leading-relaxed text-text-primary">
                        {archived
                          ? t('projects.deleteWarning')
                          : t('projects.deleteWarningArchiveFirst')}
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          onClick={() => setConfirmDelete(false)}
                          className="flex-1 rounded-lg px-3 py-1.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-hover"
                        >
                          {t('common.cancel')}
                        </button>
                        <button
                          onClick={handleDelete}
                          disabled={isDeleting}
                          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-error px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:brightness-110 disabled:opacity-60"
                        >
                          {isDeleting ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <Trash2 className="h-3 w-3" />
                          )}
                          <span>{t('projects.deleteConfirm')}</span>
                        </button>
                      </div>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-error transition-colors hover:brightness-110"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>{t('projects.deletePermanently')}</span>
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-border-muted px-6 py-4">
          <div>
            {isEdit && (
              <button
                onClick={handleArchiveToggle}
                className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-[13px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
              >
                {archived ? (
                  <>
                    <ArchiveRestore className="h-3.5 w-3.5" />
                    <span>{t('projects.restore')}</span>
                  </>
                ) : (
                  <>
                    <Archive className="h-3.5 w-3.5" />
                    <span>{t('projects.archive')}</span>
                  </>
                )}
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-[10px] text-text-muted sm:block">
              {t('projects.saveShortcutHint')}
            </span>
            <button
              onClick={closeProjectsModal}
              className="rounded-xl border border-border px-4 py-2 text-[13px] text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              {isSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              <span>{t('projects.save')}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
