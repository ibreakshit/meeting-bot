import { Frame, Page } from 'playwright';

/** Dismiss Zoom's known advisory overlays without touching meeting or recording controls. */
export async function installZoomNoticeDismissal(frame: Frame | Page): Promise<() => Promise<void>> {
  await frame.evaluate(() => {
    const noticeWindow = window as typeof window & { stopMeetingBotZoomNotices?: () => void };
    noticeWindow.stopMeetingBotZoomNotices?.();

    const overlaySelector = [
      '[role="alert"]', '[role="status"]', '[role="tooltip"]', '[role="dialog"]',
      '[class*="notification"]', '[class*="toast"]', '[class*="tooltip"]',
      '[class*="popover"]', '[class*="banner"]',
    ].join(',');
    const isVisible = (element: HTMLElement) => element.getClientRects().length > 0
      && getComputedStyle(element).visibility !== 'hidden';
    const hiddenPanels = new Map<HTMLElement, { value: string; priority: string }>();
    const restorePanel = (panel: HTMLElement) => {
      const previous = hiddenPanels.get(panel);
      if (!previous) return;
      panel.style.setProperty('display', previous.value, previous.priority);
      hiddenPanels.delete(panel);
    };
    const dismissNotices = () => {
      for (const panel of hiddenPanels.keys()) {
        if (!panel.isConnected || !panel.matches(overlaySelector)) restorePanel(panel);
      }
      for (const panel of document.querySelectorAll<HTMLElement>(overlaySelector)) {
        if (!isVisible(panel) && !hiddenPanels.has(panel)) continue;
        const text = (panel.innerText || '').replace(/\s+/g, ' ').trim();
        // Match the observed advice, not arbitrary alerts or participant messages.
        const isNotes = /^Introducing My Notes/i.test(text);
        const isDevice = /^(?:Please enable access to your microphone and camera for the best experience\.|Cannot detect your (?:camera|microphone)\b)/i.test(text);
        const isHardware = /^For a better meeting experience, enable the option ['“]?Use graphics\/hardware acceleration/i.test(text);
        const isAppsTooltip = text === 'See apps that are accessing your meeting content';
        if (!(isNotes || isDevice || isHardware || isAppsTooltip) || text.length > 1500
          || /\b(recording|recorded|consent)\b/i.test(text)
          || panel.querySelector('video, canvas, iframe, input, textarea')) {
          // Zoom can reuse a toast container for a different message later.
          restorePanel(panel);
          continue;
        }
        if (hiddenPanels.has(panel)) continue;

        const dismissButton = [...panel.querySelectorAll<HTMLElement>('button, [role="button"]')]
          .find(button => {
            const label = (button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent || '').trim();
            return isVisible(button) && (/^(close(?: notification)?|dismiss|[×✕x])$/i.test(label)
              || (isNotes && /^got it$/i.test(label)));
          });
        dismissButton?.click();
        // Some Zoom advice has no close control. Hide only that recognized overlay.
        if (isVisible(panel)) {
          hiddenPanels.set(panel, {
            value: panel.style.getPropertyValue('display'),
            priority: panel.style.getPropertyPriority('display'),
          });
          panel.style.setProperty('display', 'none', 'important');
        }
      }
    };

    let pendingSweep: number | undefined;
    const observer = new MutationObserver(() => {
      if (pendingSweep !== undefined) return;
      pendingSweep = window.setTimeout(() => {
        pendingSweep = undefined;
        dismissNotices();
      }, 100);
    });
    const stop = () => {
      observer.disconnect();
      window.clearTimeout(pendingSweep);
      for (const panel of hiddenPanels.keys()) restorePanel(panel);
      window.removeEventListener('pagehide', stop);
      delete noticeWindow.stopMeetingBotZoomNotices;
    };
    noticeWindow.stopMeetingBotZoomNotices = stop;
    window.addEventListener('pagehide', stop, { once: true });
    dismissNotices();
    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
  });

  return async () => {
    // Recording normally closes the browser before this cleanup runs.
    await frame.evaluate(() => {
      (window as typeof window & { stopMeetingBotZoomNotices?: () => void }).stopMeetingBotZoomNotices?.();
    }).catch(() => undefined);
  };
}
