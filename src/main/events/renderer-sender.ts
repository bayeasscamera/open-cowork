/**
 * Central renderer event dispatcher.
 *
 * Extracted from main/index.ts: routes every ServerEvent either to the remote
 * channel (when the session is remote) or to the local renderer/headless
 * sender, dispatching native notifications for permission/task events.
 */
import type { BrowserWindow } from 'electron';
import type { ServerEvent } from '../../shared/types';
import { remoteManager } from '../remote/remote-manager';
import type { SessionManager } from '../session/session-manager';
import { log, logError, logWarn } from '../utils/logger';
import { SystemNotifier } from '../utils/system-notifier';

/** Accessors for the mutable app-level singletons owned by main/index.ts. */
export interface RendererSenderContext {
  getMainWindow(): BrowserWindow | null;
  getEventSender(): ((event: ServerEvent) => void) | null;
  getSessionManager(): SessionManager | null;
}

// Tracks session running/idle state transitions for task completion notifications
const sessionStatusTracker = new Map<string, string>();

let context: RendererSenderContext | null = null;

export function setRendererSenderContext(next: RendererSenderContext): void {
  context = next;
}

export function sendToRenderer(event: ServerEvent) {
  if (!context) {
    throw new Error('RendererSenderContext not configured');
  }
  const { getMainWindow, getEventSender, getSessionManager } = context;
  const mainWindow = getMainWindow();
  const eventSender = getEventSender();
  const sessionManager = getSessionManager();

  const payload =
    'payload' in event
      ? (event.payload as { sessionId?: string; [key: string]: unknown })
      : undefined;
  const sessionId = payload?.sessionId;

  // 判断是否远程会话
  if (sessionId && remoteManager.isRemoteSession(sessionId)) {
    // 处理远程会话事件

    // 拦截 stream.message，用于回传到远程通道
    if (event.type === 'stream.message') {
      const message = payload.message as {
        role?: string;
        content?: Array<{ type: string; text?: string }>;
      };
      if (message?.role === 'assistant' && message?.content) {
        // 提取助手文本内容
        const textContent = message.content
          .filter((c) => c.type === 'text' && c.text)
          .map((c) => c.text)
          .join('\n');

        if (textContent) {
          // 发送到远程通道（带缓冲）
          remoteManager.sendResponseToChannel(sessionId, textContent).catch((err: Error) => {
            logError('[Remote] Failed to send response to channel:', err);
          });
        }
      }
    }

    // 拦截 trace.step 作为工具进度
    if (event.type === 'trace.step') {
      const step = payload.step as {
        type?: string;
        toolName?: string;
        status?: string;
        title?: string;
      };
      if (step?.type === 'tool_call' && step?.toolName) {
        remoteManager
          .sendToolProgress(
            sessionId,
            step.toolName,
            step.status === 'completed'
              ? 'completed'
              : step.status === 'error'
                ? 'error'
                : 'running'
          )
          .catch((err: Error) => {
            logError('[Remote] Failed to send tool progress:', err);
          });
      }
    }

    // trace.update 预留；当前主要用 trace.step

    // 拦截 session.status 用于清理
    if (event.type === 'session.status') {
      const status = payload.status as string;
      if (status === 'idle' || status === 'error') {
        // 会话结束，清空缓冲
        remoteManager.clearSessionBuffer(sessionId).catch((err: Error) => {
          logError('[Remote] Failed to clear session buffer:', err);
        });
      }
    }

    // 拦截 permission.request
    if (event.type === 'permission.request' && payload.toolUseId && payload.toolName) {
      log('[Remote] Intercepting permission for remote session:', sessionId);
      remoteManager
        .handlePermissionRequest(
          sessionId,
          payload.toolUseId as string,
          payload.toolName as string,
          (payload.input as Record<string, unknown> | undefined) ?? {}
        )
        .then((result) => {
          if (result !== null && sessionManager) {
            let permissionResult: 'allow' | 'deny' | 'allow_always';
            if (result.allow) {
              permissionResult = result.remember ? 'allow_always' : 'allow';
            } else {
              permissionResult = 'deny';
            }
            sessionManager.handlePermissionResponse(payload.toolUseId as string, permissionResult);
          }
        })
        .catch((err) => {
          logError('[Remote] Failed to handle permission request:', err);
        });
      return; // 不发送到本地 UI
    }
  }

  // 发送到本地 UI（or headless JSONL sender）
  if (eventSender) {
    eventSender(event);
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('server-event', event);

    // Native desktop notifications when the app is in the background (user is in another app)
    try {
      if (event.type === 'permission.request' && payload?.toolName) {
        SystemNotifier.notifyPermissionRequired(mainWindow, payload.toolName as string, sessionId);
      } else if (event.type === 'sudo.password.request') {
        SystemNotifier.notifySudoRequired(mainWindow, (payload?.command as string) || '', sessionId);
      } else if (event.type === 'session.status') {
        const status = payload?.status as string | undefined;
        const sId = sessionId || 'default';
        const prevStatus = sessionStatusTracker.get(sId);
        sessionStatusTracker.set(sId, status || '');

        if (prevStatus === 'running' && status === 'idle') {
          let sessionTitle: string | undefined;
          if (sessionId && sessionManager) {
            try {
              const s = sessionManager.loadSession(sessionId);
              sessionTitle = s?.title;
            } catch {
              /* best-effort session lookup */
            }
          }
          SystemNotifier.notifyTaskCompleted(mainWindow, sessionTitle, sessionId);
        }
      } else if (event.type === 'trace.step') {
        const step = payload?.step as { type?: string; toolName?: string; title?: string } | undefined;
        if (step?.type === 'tool_call' && step.toolName?.toLowerCase().includes('ask')) {
          SystemNotifier.notifyQuestionAsked(mainWindow, step.title, sessionId);
        }
      } else if (event.type === 'stream.message') {
        const message = payload?.message as {
          role?: string;
          content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
        } | undefined;
        if (message?.role === 'assistant' && Array.isArray(message.content)) {
          const askBlock = message.content.find(
            (c) => c.type === 'tool_use' && c.name?.toLowerCase().includes('ask')
          );
          if (askBlock) {
            const q = (askBlock.input?.questions as Array<{ question?: string }>) || [];
            const questionText = q[0]?.question || (askBlock.input?.question as string) || undefined;
            SystemNotifier.notifyQuestionAsked(mainWindow, questionText, sessionId);
          }
        }
      }
    } catch (notifErr) {
      logWarn('[App] Error dispatching system notification:', notifErr);
    }
  }
}
