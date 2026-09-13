/**
 * @module main/utils/system-notifier
 * Native desktop notifications for Open Cowork.
 * Notifies the user when:
 * 1. A tool requires permission approval
 * 2. Sudo password is required
 * 3. An agent asks a question
 * 4. A background task or session execution completes
 *
 * Only notifies if the main window is not currently focused (user is in another app).
 */
import { Notification, BrowserWindow, app } from 'electron';
import { log } from './logger';

export interface SystemNotificationOptions {
  title: string;
  body: string;
  urgency?: 'normal' | 'critical';
  sessionId?: string;
}

export class SystemNotifier {
  private static enabled = true;

  public static setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  public static isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Send a native desktop notification if the main window is unfocused.
   */
  public static notifyIfUnfocused(
    window: BrowserWindow | null,
    options: SystemNotificationOptions
  ): boolean {
    if (!this.enabled) return false;

    // Only notify if window is not focused (user is in another app)
    // or if the window is minimized / hidden
    if (window && window.isFocused() && !window.isMinimized()) {
      return false;
    }

    // Bounce dock icon on macOS
    if (process.platform === 'darwin') {
      try {
        app.dock?.bounce(options.urgency === 'critical' ? 'critical' : 'informational');
      } catch {
        /* best-effort dock bounce */
      }
    }

    if (!Notification.isSupported()) {
      log('[SystemNotifier] Native notifications not supported on this platform');
      return false;
    }

    try {
      const notification = new Notification({
        title: options.title,
        body: options.body,
        urgency: options.urgency === 'critical' ? 'critical' : 'normal',
        silent: false,
      });

      notification.on('click', () => {
        if (window && !window.isDestroyed()) {
          if (window.isMinimized()) {
            window.restore();
          }
          window.show();
          window.focus();
        }
      });

      notification.show();
      return true;
    } catch (err) {
      log('[SystemNotifier] Failed to show notification:', err);
      return false;
    }
  }

  /**
   * Notify user about a pending permission request
   */
  public static notifyPermissionRequired(
    window: BrowserWindow | null,
    toolName: string,
    sessionId?: string
  ): void {
    this.notifyIfUnfocused(window, {
      title: 'Open Cowork — Autorisation requise',
      body: `L'agent demande l'autorisation d'exécuter l'outil "${toolName}".`,
      urgency: 'critical',
      sessionId,
    });
  }

  /**
   * Notify user about a sudo password request
   */
  public static notifySudoRequired(
    window: BrowserWindow | null,
    command: string,
    sessionId?: string
  ): void {
    const preview = command.length > 50 ? `${command.slice(0, 47)}...` : command;
    this.notifyIfUnfocused(window, {
      title: 'Open Cowork — Mot de passe administrateur requis',
      body: `Une commande requiert les droits sudo : ${preview}`,
      urgency: 'critical',
      sessionId,
    });
  }

  /**
   * Notify user when an agent asks a question
   */
  public static notifyQuestionAsked(
    window: BrowserWindow | null,
    questionText?: string,
    sessionId?: string
  ): void {
    const preview = questionText
      ? questionText.length > 80
        ? `${questionText.slice(0, 77)}...`
        : questionText
      : "L'agent a posé une question et attend votre réponse.";

    this.notifyIfUnfocused(window, {
      title: 'Open Cowork — Question de l’agent',
      body: preview,
      urgency: 'critical',
      sessionId,
    });
  }

  /**
   * Notify user when a task completes
   */
  public static notifyTaskCompleted(
    window: BrowserWindow | null,
    sessionTitle?: string,
    sessionId?: string
  ): void {
    const body = sessionTitle
      ? `Tâche terminée : "${sessionTitle}"`
      : 'L’agent a terminé son travail avec succès.';

    this.notifyIfUnfocused(window, {
      title: 'Open Cowork — Tâche terminée',
      body,
      urgency: 'normal',
      sessionId,
    });
  }
}
