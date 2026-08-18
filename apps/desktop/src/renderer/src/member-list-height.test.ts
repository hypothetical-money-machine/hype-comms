// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from "vitest";

import {
  applyMemberListHeight,
  clampMemberListHeight,
  DEFAULT_MEMBER_LIST_HEIGHT,
  maxMemberListHeight,
  MEMBER_LIST_HEIGHT_CSS_VARIABLE,
  MEMBER_LIST_HEIGHT_STORAGE_KEY,
  MEMBER_LIST_RESIZE_HANDLE_HEIGHT,
  memberListHeightFromPointer,
  MIN_CONVERSATION_NAV_HEIGHT,
  MIN_MEMBER_LIST_HEIGHT,
  parseMemberListHeight,
  persistMemberListHeight,
  readMemberListHeight,
  restoreMemberListHeight,
  type MemberListHeightStorage,
} from "./member-list-height";

class MemoryStorage implements MemberListHeightStorage {
  readonly values = new Map<string, string>();
  getError: Error | null = null;
  setError: Error | null = null;

  getItem(key: string): string | null {
    if (this.getError !== null) throw this.getError;
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.setError !== null) throw this.setError;
    this.values.set(key, value);
  }
}

afterEach(() => {
  document.documentElement.style.removeProperty(MEMBER_LIST_HEIGHT_CSS_VARIABLE);
});

describe("member list height", () => {
  it("parses whole-pixel heights inside the allowed range", () => {
    expect(parseMemberListHeight("220")).toBe(220);
    expect(parseMemberListHeight("80")).toBe(80);
    expect(parseMemberListHeight(null)).toBeNull();
    expect(parseMemberListHeight("")).toBeNull();
    expect(parseMemberListHeight("220px")).toBeNull();
    expect(parseMemberListHeight("79")).toBeNull();
    expect(parseMemberListHeight("-12")).toBeNull();
    expect(parseMemberListHeight("12.5")).toBeNull();
    expect(parseMemberListHeight("4001")).toBeNull();
  });

  it("keeps a floor so the members list cannot collapse", () => {
    expect(clampMemberListHeight(12, 600)).toBe(MIN_MEMBER_LIST_HEIGHT);
    expect(clampMemberListHeight(180.6, 600)).toBe(181);
  });

  it("leaves room for the conversation list when the split is short", () => {
    const available = 280;
    expect(maxMemberListHeight(available)).toBe(
      available - MIN_CONVERSATION_NAV_HEIGHT - MEMBER_LIST_RESIZE_HANDLE_HEIGHT,
    );
    expect(clampMemberListHeight(400, available)).toBe(maxMemberListHeight(available));
  });

  it("maps pointer position from the bottom of the split", () => {
    expect(memberListHeightFromPointer(300, 500, 400)).toBe(200);
    expect(memberListHeightFromPointer(490, 500, 400)).toBe(MIN_MEMBER_LIST_HEIGHT);
  });

  it("defaults and fails closed when storage is missing or unreadable", () => {
    expect(readMemberListHeight(null)).toBe(DEFAULT_MEMBER_LIST_HEIGHT);
    expect(readMemberListHeight(new MemoryStorage())).toBe(DEFAULT_MEMBER_LIST_HEIGHT);

    const malformed = new MemoryStorage();
    malformed.values.set(MEMBER_LIST_HEIGHT_STORAGE_KEY, "tall");
    expect(readMemberListHeight(malformed)).toBe(DEFAULT_MEMBER_LIST_HEIGHT);

    const unreadable = new MemoryStorage();
    unreadable.getError = new Error("storage denied");
    expect(readMemberListHeight(unreadable)).toBe(DEFAULT_MEMBER_LIST_HEIGHT);
  });

  it("restores a saved height onto the document before React mounts", () => {
    const storage = new MemoryStorage();
    storage.values.set(MEMBER_LIST_HEIGHT_STORAGE_KEY, "160");

    expect(restoreMemberListHeight(document.documentElement, storage)).toBe(160);
    expect(document.documentElement.style.getPropertyValue(MEMBER_LIST_HEIGHT_CSS_VARIABLE)).toBe(
      "160px",
    );
  });

  it("persists changes and keeps the session height when persistence fails", () => {
    const storage = new MemoryStorage();
    persistMemberListHeight(180, storage);
    expect(storage.values.get(MEMBER_LIST_HEIGHT_STORAGE_KEY)).toBe("180");

    storage.setError = new Error("storage denied");
    persistMemberListHeight(200, storage);
    expect(storage.values.get(MEMBER_LIST_HEIGHT_STORAGE_KEY)).toBe("180");

    applyMemberListHeight(document.documentElement, 200);
    expect(document.documentElement.style.getPropertyValue(MEMBER_LIST_HEIGHT_CSS_VARIABLE)).toBe(
      "200px",
    );
  });
});
