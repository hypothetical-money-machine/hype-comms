const BOTTOM_THRESHOLD = 48;

export function isTimelineAtBottom(container: HTMLElement): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= BOTTOM_THRESHOLD;
}

export function lastFullyVisibleMessageId(container: HTMLElement): string | null {
  const viewport = container.getBoundingClientRect();
  let lastVisible: string | null = null;
  for (const message of container.querySelectorAll<HTMLElement>("[data-message-id]")) {
    const bounds = message.getBoundingClientRect();
    if (bounds.bottom > viewport.top && bounds.bottom <= viewport.bottom + 1) {
      lastVisible = message.dataset.messageId ?? null;
    }
  }
  return lastVisible;
}
