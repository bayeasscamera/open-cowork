import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  ArchiveRestore,
  FileText,
  FolderOpen,
  Loader2,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react';
import type { Project } from '../types';
import { useAppStore } from '../store';
import {
  buildConfigSetLites,
  ConfigSetModelPicker,
} from './shared/ConfigSetModelPicker';

/**
 * Projects editor modal — creation and detail/edit of a Project.
 * A project binds a workspace folder, persistent instructions, reference
 * files and an optional ConfigSet; sessions started while the project is
 * active inherit that context (injected by the main process at session start).
 */
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
      if (folder) setWorkdir(folder);
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
      const result = await window.electronAPI.projects.detachFile(
        projectsModalProjectId,
        filePath
      );
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

  const handleSave = async () => {
    setError(null);
    if (!name.trim() || !workdir.trim()) {
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

  const handleArchiveToggle = async () => {
    if (!projectsModalProjectId) return;
    try {
      const result = await window.electronAPI.projects.archive(
        projectsModalProjectId,
        !archived
      );
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
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border border-border bg-background shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={isEdit ? t('projects.editTitle') : t('projects.newTitle')}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-border-muted">
          <h2 className="text-[15px] font-semibold text-text-primary">
            {isEdit ? t('projects.editTitle') : t('projects.newTitle')}
          </h2>
          <button
            onClick={closeProjectsModal}
            className="w-8 h-8 rounded-xl flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
            title={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {isLoading ? (
            <div className="flex items-center gap-2 py-8 text-text-secondary">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">{t('projects.loading')}</span>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4">
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1.5">
                    {t('projects.name')} *
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('projects.namePlaceholder')}
                    className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-[13px] text-text-primary focus:outline-none focus:border-accent"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1.5">
                    {t('projects.workdir')} *
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={workdir}
                      onChange={(e) => setWorkdir(e.target.value)}
                      placeholder={t('projects.workdirPlaceholder')}
                      className="flex-1 rounded-xl border border-border bg-surface px-3 py-2 text-[13px] text-text-primary focus:outline-none focus:border-accent"
                    />
                    <button
                      onClick={handleSelectWorkdir}
                      className="flex items-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-[13px] text-text-primary hover:bg-surface-hover transition-colors"
                      title={t('projects.browse')}
                    >
                      <FolderOpen className="w-3.5 h-3.5" />
                      <span>{t('projects.browse')}</span>
                    </button>
                  </div>
                  <p className="mt-1 text-[11px] text-text-muted">{t('projects.workdirHint')}</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1.5">
                    {t('projects.description')}
                  </label>
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t('projects.descriptionPlaceholder')}
                    className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-[13px] text-text-primary focus:outline-none focus:border-accent"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1.5">
                    {t('projects.configSet')}
                  </label>
                  <div className="flex flex-col gap-2">
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
                  </div>
                  <p className="mt-1 text-[11px] text-text-muted">{t('projects.configSetHint')}</p>
                </div>

                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1.5">
                    {t('projects.instructions')}
                  </label>
                  <textarea
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    placeholder={t('projects.instructionsPlaceholder')}
                    rows={5}
                    className="w-full rounded-xl border border-border bg-surface px-3 py-2 text-[13px] text-text-primary focus:outline-none focus:border-accent resize-y"
                  />
                  <p className="mt-1 text-[11px] text-text-muted">{t('projects.instructionsHint')}</p>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-medium text-text-secondary">
                    {t('projects.referenceFiles')}
                  </label>
                  {isEdit && (
                    <button
                      onClick={handleAttachFiles}
                      className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                    >
                      <Plus className="w-3 h-3" />
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
                        className="flex items-center gap-2 rounded-lg bg-surface px-2.5 py-1.5"
                      >
                        <FileText className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
                        <span
                          className="flex-1 min-w-0 truncate text-[12px] text-text-primary"
                          title={filePath}
                        >
                          {filePath}
                        </span>
                        {isEdit && (
                          <button
                            onClick={() => handleDetachFile(filePath)}
                            className="w-6 h-6 rounded-lg flex items-center justify-center text-text-muted hover:text-red-400 hover:bg-surface-hover transition-colors"
                            title={t('projects.removeFile')}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {!isEdit && (
                  <p className="mt-1 text-[11px] text-text-muted">
                    {t('projects.attachAfterCreate')}
                  </p>
                )}
              </div>

              {isEdit && sessions.length > 0 && (
                <div>
                  <label className="block text-xs font-medium text-text-secondary mb-1.5">
                    {t('projects.sessions')} ({sessions.length})
                  </label>
                  <ul className="space-y-1 max-h-40 overflow-y-auto">
                    {sessions.map((session) => (
                      <li
                        key={session.id}
                        onClick={() => {
                          useAppStore.getState().setActiveSession(session.id);
                          closeProjectsModal();
                        }}
                        className="cursor-pointer flex items-center justify-between rounded-lg bg-surface px-2.5 py-1.5 hover:bg-surface-hover transition-colors"
                      >
                        <span className="min-w-0 truncate text-[12px] text-text-primary">
                          {session.title}
                        </span>
                        <span className="text-[11px] text-text-muted flex-shrink-0 ml-2">
                          {session.status}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {error && (
                <p className="text-[12px] text-red-400" role="alert">
                  {error}
                </p>
              )}

              {isEdit && (
                <div className="rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2.5">
                  {confirmDelete ? (
                    <>
                      <p className="text-[12px] text-text-primary leading-relaxed">
                        {archived
                          ? t('projects.deleteWarning')
                          : t('projects.deleteWarningArchiveFirst')}
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <button
                          onClick={() => setConfirmDelete(false)}
                          className="flex-1 px-3 py-1.5 rounded-lg text-[12px] font-medium text-text-secondary hover:bg-surface-hover transition-colors"
                        >
                          {t('common.cancel')}
                        </button>
                        <button
                          onClick={handleDelete}
                          disabled={isDeleting}
                          className="flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-60"
                        >
                          {isDeleting ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Trash2 className="w-3 h-3" />
                          )}
                          <span>{t('projects.deleteConfirm')}</span>
                        </button>
                      </div>
                    </>
                  ) : (
                    <button
                      onClick={() => setConfirmDelete(true)}
                      className="flex items-center gap-1.5 text-[12px] font-medium text-red-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{t('projects.deletePermanently')}</span>
                    </button>
                  )}
                </div>
              )}

              <div className="flex items-center justify-between pt-2">
                <div>
                  {isEdit && (
                    <button
                      onClick={handleArchiveToggle}
                      className="flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-[13px] text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                    >
                      {archived ? (
                        <>
                          <ArchiveRestore className="w-3.5 h-3.5" />
                          <span>{t('projects.restore')}</span>
                        </>
                      ) : (
                        <>
                          <Archive className="w-3.5 h-3.5" />
                          <span>{t('projects.archive')}</span>
                        </>
                      )}
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={closeProjectsModal}
                    className="rounded-xl border border-border px-4 py-2 text-[13px] text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="flex items-center gap-1.5 rounded-xl bg-accent px-4 py-2 text-[13px] font-medium text-white hover:bg-accent-hover transition-colors disabled:opacity-60"
                  >
                    {isSaving ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Save className="w-3.5 h-3.5" />
                    )}
                    <span>{t('projects.save')}</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
