export interface TimelineScrollAnchor {
  readonly messageId: string;
  readonly row: HTMLElement;
  readonly offset: number;
}

/** Prefer a fully visible row; a viewport inside one tall message anchors that message instead. */
export function captureTimelineScrollAnchor(container: HTMLElement): TimelineScrollAnchor | null {
  const viewport = container.getBoundingClientRect();
  if (viewport.height <= 0 || viewport.width <= 0) return null;
  const rows = container.querySelectorAll<HTMLElement>("article[data-message-id]");
  // Timeline rows follow document order. Find the viewport without measuring loaded history.
  let start = 0;
  let end = rows.length;
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (rows[middle]!.getBoundingClientRect().bottom <= viewport.top) start = middle + 1;
    else end = middle;
  }
  let partial: TimelineScrollAnchor | null = null;
  for (let index = start; index < rows.length; index++) {
    const row = rows[index]!;
    const bounds = row.getBoundingClientRect();
    if (bounds.top >= viewport.bottom) break;
    const messageId = row.dataset.messageId;
    if (messageId === undefined) continue;
    const anchor = { messageId, row, offset: bounds.top - viewport.top };
    if (bounds.top >= viewport.top && bounds.bottom <= viewport.bottom) return anchor;
    partial ??= anchor;
  }
  return partial;
}

function timelineScrollAnchorOffset(
  container: HTMLElement,
  anchor: TimelineScrollAnchor,
): number | null {
  if (!container.contains(anchor.row) || anchor.row.dataset.messageId !== anchor.messageId) {
    return null;
  }
  return anchor.row.getBoundingClientRect().top - container.getBoundingClientRect().top;
}

export function isTimelineScrollAnchorPreserved(
  container: HTMLElement,
  anchor: TimelineScrollAnchor,
): boolean {
  const offset = timelineScrollAnchorOffset(container, anchor);
  return offset !== null && Math.abs(offset - anchor.offset) <= 1;
}

export function restoreTimelineScrollAnchor(
  container: HTMLElement,
  anchor: TimelineScrollAnchor,
): void {
  const offset = timelineScrollAnchorOffset(container, anchor);
  if (offset !== null) container.scrollTop += offset - anchor.offset;
}
