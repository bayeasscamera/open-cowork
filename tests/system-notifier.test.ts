import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SystemNotifier } from '../src/main/utils/system-notifier';
import type { BrowserWindow } from 'electron';

// Mock electron
vi.mock('electron', () => {
  class MockNotification {
    static isSupported() {
      return true;
    }
    options: unknown;
    constructor(options: unknown) {
      this.options = options;
    }
    show = vi.fn();
    on = vi.fn();
  }

  return {
    Notification: MockNotification,
    BrowserWindow: vi.fn(),
    app: {
      dock: {
        bounce: vi.fn(),
      },
    },
  };
});

describe('SystemNotifier', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    SystemNotifier.setEnabled(true);
  });

  it('does NOT notify when window is focused and visible', () => {
    const mockWindow = {
      isFocused: () => true,
      isMinimized: () => false,
      isDestroyed: () => false,
      show: vi.fn(),
      focus: vi.fn(),
    } as unknown as BrowserWindow;

    const notified = SystemNotifier.notifyIfUnfocused(mockWindow, {
      title: 'Test',
      body: 'Body',
    });

    expect(notified).toBe(false);
  });

  it('notifies when window is NOT focused (user in another app)', () => {
    const mockWindow = {
      isFocused: () => false,
      isMinimized: () => false,
      isDestroyed: () => false,
      show: vi.fn(),
      focus: vi.fn(),
    } as unknown as BrowserWindow;

    const notified = SystemNotifier.notifyIfUnfocused(mockWindow, {
      title: 'Open Cowork — Autorisation requise',
      body: 'Outil bash',
      urgency: 'critical',
    });

    expect(notified).toBe(true);
  });

  it('notifies when window is minimized even if reported focused', () => {
    const mockWindow = {
      isFocused: () => true,
      isMinimized: () => true,
      isDestroyed: () => false,
      show: vi.fn(),
      focus: vi.fn(),
    } as unknown as BrowserWindow;

    const notified = SystemNotifier.notifyIfUnfocused(mockWindow, {
      title: 'Tâche terminée',
      body: 'Succès',
    });

    expect(notified).toBe(true);
  });

  it('does NOT notify when disabled via setEnabled(false)', () => {
    SystemNotifier.setEnabled(false);

    const mockWindow = {
      isFocused: () => false,
      isMinimized: () => false,
      isDestroyed: () => false,
    } as unknown as BrowserWindow;

    const notified = SystemNotifier.notifyIfUnfocused(mockWindow, {
      title: 'Test',
      body: 'Body',
    });

    expect(notified).toBe(false);
  });

  it('provides helpers for permission, sudo, question, and task completed', () => {
    const mockWindow = {
      isFocused: () => false,
      isMinimized: () => false,
      isDestroyed: () => false,
    } as unknown as BrowserWindow;

    // Must not throw and should send
    expect(() => {
      SystemNotifier.notifyPermissionRequired(mockWindow, 'bash');
      SystemNotifier.notifySudoRequired(mockWindow, 'apt-get install -y');
      SystemNotifier.notifyQuestionAsked(mockWindow, 'Voulez-vous continuer ?');
      SystemNotifier.notifyTaskCompleted(mockWindow, 'Fix bug');
    }).not.toThrow();
  });
});
