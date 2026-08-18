export const DEFAULT_MEMBER_LIST_HEIGHT = 220;
export const MIN_MEMBER_LIST_HEIGHT = 80;
export const MIN_CONVERSATION_NAV_HEIGHT = 96;
export const MEMBER_LIST_RESIZE_HANDLE_HEIGHT = 8;
export const MEMBER_LIST_HEIGHT_KEYBOARD_STEP = 16;
export const MEMBER_LIST_HEIGHT_STORAGE_KEY = "hype-comms:member-list-height";
export const MEMBER_LIST_HEIGHT_CSS_VARIABLE = "--member-list-height";

const ABSOLUTE_MAX_MEMBER_LIST_HEIGHT = 4000;

export interface MemberListHeightStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

function browserStorage(): MemberListHeightStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function parseMemberListHeight(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  if (parsed < MIN_MEMBER_LIST_HEIGHT || parsed > ABSOLUTE_MAX_MEMBER_LIST_HEIGHT) {
    return null;
  }
  return parsed;
}

export function maxMemberListHeight(availableSplitHeight: number): number {
  if (availableSplitHeight <= 0) return ABSOLUTE_MAX_MEMBER_LIST_HEIGHT;
  return Math.max(
    MIN_MEMBER_LIST_HEIGHT,
    availableSplitHeight - MIN_CONVERSATION_NAV_HEIGHT - MEMBER_LIST_RESIZE_HANDLE_HEIGHT,
  );
}

export function clampMemberListHeight(height: number, availableSplitHeight: number): number {
  return Math.min(
    maxMemberListHeight(availableSplitHeight),
    Math.max(MIN_MEMBER_LIST_HEIGHT, Math.round(height)),
  );
}

export function memberListHeightFromPointer(
  clientY: number,
  splitBottom: number,
  availableSplitHeight: number,
): number {
  return clampMemberListHeight(splitBottom - clientY, availableSplitHeight);
}

export function readMemberListHeight(
  storage: MemberListHeightStorage | null = browserStorage(),
): number {
  try {
    return (
      parseMemberListHeight(storage?.getItem(MEMBER_LIST_HEIGHT_STORAGE_KEY) ?? null) ??
      DEFAULT_MEMBER_LIST_HEIGHT
    );
  } catch {
    return DEFAULT_MEMBER_LIST_HEIGHT;
  }
}

export function persistMemberListHeight(
  height: number,
  storage: MemberListHeightStorage | null = browserStorage(),
): void {
  try {
    storage?.setItem(MEMBER_LIST_HEIGHT_STORAGE_KEY, String(height));
  } catch {
    // Height remains usable for this session when DOM storage is unavailable.
  }
}

export function applyMemberListHeight(root: HTMLElement, height: number): void {
  root.style.setProperty(MEMBER_LIST_HEIGHT_CSS_VARIABLE, `${String(height)}px`);
}

export function restoreMemberListHeight(
  root: HTMLElement,
  storage: MemberListHeightStorage | null = browserStorage(),
): number {
  const height = readMemberListHeight(storage);
  applyMemberListHeight(root, height);
  return height;
}
