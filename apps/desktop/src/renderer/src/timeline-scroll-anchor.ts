export interface TimelineScrollAnchor {
  readonly messageId: string;
  readonly offset: number;
}

/** Prefer a fully visible row; a viewport inside one tall message anchors that message instead. */
export function captureTimelineScrollAnchor(container: HTMLElement): TimelineScrollAnchor | null {
  const viewport = container.getBoundingClientRect();
  if (viewport.height <= 0 || viewport.width <= 0) return null;
  let partial: TimelineScrollAnchor | null = null;
  for (const row of container.querySelectorAll<HTMLElement>("article[data-message-id]")) {
    const bounds = row.getBoundingClientRect();
    if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) continue;
    const messageId = row.dataset.messageId;
    if (messageId === undefined) continue;
    const anchor = { messageId, offset: bounds.top - viewport.top };
    if (bounds.top >= viewport.top && bounds.bottom <= viewport.bottom) return anchor;
    partial ??= anchor;
  }
  return partial;
}

export function restoreTimelineScrollAnchor(
  container: HTMLElement,
  anchor: TimelineScrollAnchor,
): void {
  const row = [...container.querySelectorAll<HTMLElement>("article[data-message-id]")].find(
    (candidate) => candidate.dataset.messageId === anchor.messageId,
  );
  if (row === undefined) return;
  const viewport = container.getBoundingClientRect();
  const offset = row.getBoundingClientRect().top - viewport.top;
  container.scrollTop += offset - anchor.offset;
}
