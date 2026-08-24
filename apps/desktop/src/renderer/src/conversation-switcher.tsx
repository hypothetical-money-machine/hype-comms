import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type { DesktopPlatform } from "../../shared/desktop-api";
import type { ChannelMode } from "@hype-comms/contracts";
import { DirectMessageIcon, GroupDirectMessageIcon } from "./conversation-indicators";
import { useOpenChangeNotifier } from "./use-open-change-notifier";

export interface SwitcherConversation {
  readonly id: string;
  readonly name: string;
  readonly kind: "channel" | "direct_message" | "group_direct_message";
  readonly isArchived: boolean;
  readonly channelMode?: ChannelMode | null;
}

interface ConversationSwitcherProps {
  readonly conversations: readonly SwitcherConversation[];
  readonly selectedConversationId: string | null;
  readonly platform: DesktopPlatform;
  readonly onSelect: (conversationId: string) => void;
  readonly onOpenChange?: (open: boolean) => void;
}

function shortcutLabel(platform: DesktopPlatform): string {
  return platform === "darwin" ? "⌘K" : "Ctrl K";
}

export function ConversationSwitcher({
  conversations,
  selectedConversationId,
  platform,
  onSelect,
  onOpenChange,
}: ConversationSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const selectedOption = useRef<HTMLButtonElement | null>(null);
  const openState = useRef(false);

  const matches = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (normalized === "") return conversations;
    return conversations.filter((conversation) =>
      conversation.name.toLocaleLowerCase().includes(normalized),
    );
  }, [conversations, query]);

  const openSwitcher = useCallback(() => {
    if (!openState.current) {
      previousFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : trigger.current;
    }
    openState.current = true;
    setQuery("");
    setSelectedIndex(0);
    setOpen(true);
  }, []);

  const closeSwitcher = useCallback((restoreFocus: boolean) => {
    openState.current = false;
    setOpen(false);
    if (restoreFocus) previousFocus.current?.focus();
  }, []);

  const choose = useCallback(
    (conversationId: string) => {
      onSelect(conversationId);
      closeSwitcher(false);
    },
    [closeSwitcher, onSelect],
  );

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent): void => {
      const modifier = platform === "darwin" ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey || event.shiftKey || event.key.toLocaleLowerCase() !== "k") {
        return;
      }
      event.preventDefault();
      openSwitcher();
    };
    document.addEventListener("keydown", onShortcut);
    return () => document.removeEventListener("keydown", onShortcut);
  }, [openSwitcher, platform]);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    selectedOption.current?.scrollIntoView?.({ block: "nearest" });
  }, [open, selectedIndex]);

  useOpenChangeNotifier(open, onOpenChange);

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeSwitcher(true);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current) => (matches.length === 0 ? 0 : (current + 1) % matches.length));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) =>
        matches.length === 0 ? 0 : (current - 1 + matches.length) % matches.length,
      );
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const conversation = matches[selectedIndex];
      if (conversation !== undefined) choose(conversation.id);
    }
  };

  const shortcut = shortcutLabel(platform);

  return (
    <>
      <button
        ref={trigger}
        className="quick-switcher-trigger"
        type="button"
        aria-haspopup="dialog"
        onClick={openSwitcher}
      >
        <span>
          <span aria-hidden="true">↗</span>
          Jump to…
        </span>
        <kbd>{shortcut}</kbd>
      </button>
      {open &&
        createPortal(
          <div className="dialog-backdrop" onMouseDown={() => closeSwitcher(true)}>
            <section
              className="quick-switcher-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="quick-switcher-title"
              onMouseDown={(event) => event.stopPropagation()}
            >
              <h2 id="quick-switcher-title" className="sr-only">
                Jump to a conversation
              </h2>
              <div className="quick-switcher-search">
                <span aria-hidden="true">⌕</span>
                <input
                  ref={input}
                  type="search"
                  aria-label="Jump to a conversation"
                  value={query}
                  autoComplete="off"
                  placeholder="Type a conversation name"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setSelectedIndex(0);
                  }}
                  onKeyDown={onInputKeyDown}
                />
                <kbd>Esc</kbd>
              </div>

              {matches.length === 0 ? (
                <p className="quick-switcher-empty">No matching conversations</p>
              ) : (
                <ol className="quick-switcher-results">
                  {matches.map((conversation, index) => (
                    <li key={conversation.id}>
                      <button
                        ref={(element) => {
                          if (index === selectedIndex) selectedOption.current = element;
                        }}
                        className={index === selectedIndex ? "selected" : undefined}
                        type="button"
                        aria-current={
                          conversation.id === selectedConversationId ? "page" : undefined
                        }
                        onMouseEnter={() => setSelectedIndex(index)}
                        onClick={() => choose(conversation.id)}
                      >
                        {conversation.kind === "channel" ? (
                          <span
                            className="quick-switcher-icon conversation-type-icon channel-icon"
                            aria-hidden="true"
                          >
                            {conversation.channelMode === "announcement" ? "📣" : "#"}
                          </span>
                        ) : conversation.kind === "group_direct_message" ? (
                          <GroupDirectMessageIcon className="quick-switcher-icon" />
                        ) : (
                          <DirectMessageIcon className="quick-switcher-icon" />
                        )}
                        <span className="quick-switcher-name" title={conversation.name}>
                          {conversation.name}
                        </span>
                        <small>
                          {conversation.isArchived
                            ? "Archived channel"
                            : conversation.kind === "channel"
                              ? conversation.channelMode === "announcement"
                                ? "Announcement channel"
                                : "Channel"
                              : conversation.kind === "group_direct_message"
                                ? "Group conversation"
                                : "Direct message"}
                        </small>
                        {conversation.id === selectedConversationId && (
                          <span className="quick-switcher-current">Current</span>
                        )}
                      </button>
                    </li>
                  ))}
                </ol>
              )}
              <footer>
                <span>
                  <kbd>↑</kbd>
                  <kbd>↓</kbd> to navigate
                </span>
                <span>
                  <kbd>↵</kbd> to select
                </span>
              </footer>
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
