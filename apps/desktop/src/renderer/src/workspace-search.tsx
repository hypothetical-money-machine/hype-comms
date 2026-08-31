import type { MessageSearchResponse, MessageSearchResult, User } from "@hype-comms/contracts";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

import { useOpenChangeNotifier } from "./use-open-change-notifier";

interface WorkspaceSearchProps {
  readonly members: readonly User[];
  readonly conversationName: (conversationId: string) => string;
  readonly search: (query: string, after?: string) => Promise<MessageSearchResponse>;
  readonly openResult: (result: MessageSearchResult) => Promise<void | boolean>;
  readonly onOpenChange?: (open: boolean) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message !== "" ? error.message : "Search failed";
}

function resultTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function WorkspaceSearch({
  members,
  conversationName,
  search,
  openResult,
  onOpenChange,
}: WorkspaceSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [results, setResults] = useState<readonly MessageSearchResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const openState = useRef(false);
  const requestGeneration = useRef(0);

  const openSearch = useCallback(() => {
    openState.current = true;
    setOpen(true);
  }, []);

  const closeSearch = useCallback((restoreFocus: boolean) => {
    openState.current = false;
    requestGeneration.current += 1;
    setOpen(false);
    setQuery("");
    setSubmittedQuery("");
    setResults([]);
    setNextCursor(null);
    setLoading(false);
    setError("");
    if (restoreFocus) trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") closeSearch(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [closeSearch, open]);

  useOpenChangeNotifier(open, onOpenChange);

  const run = async (after?: string): Promise<void> => {
    const normalized = after === undefined ? query.trim() : submittedQuery;
    if (normalized.length < 2) {
      setError("Enter at least two characters.");
      input.current?.focus();
      return;
    }
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    if (after === undefined) {
      setSubmittedQuery(normalized);
      setResults([]);
      setNextCursor(null);
    }
    setLoading(true);
    setError("");
    try {
      const response = await search(normalized, after);
      if (!openState.current || generation !== requestGeneration.current) return;
      setResults((current) =>
        after === undefined ? response.results : [...current, ...response.results],
      );
      setNextCursor(response.nextCursor);
    } catch (searchError) {
      if (!openState.current || generation !== requestGeneration.current) return;
      setError(errorMessage(searchError));
    } finally {
      if (openState.current && generation === requestGeneration.current) setLoading(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void run();
  };

  return (
    <>
      <button ref={trigger} className="workspace-search-button" type="button" onClick={openSearch}>
        <span>
          <span aria-hidden="true">⌕</span>
          Search messages
        </span>
      </button>
      {open &&
        createPortal(
          <div className="dialog-backdrop" onMouseDown={() => closeSearch(true)}>
            <section
              className="workspace-search-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="workspace-search-title"
              aria-busy={loading}
              onMouseDown={(event) => event.stopPropagation()}
            >
              <header>
                <div>
                  <p className="eyebrow">Workspace search</p>
                  <h2 id="workspace-search-title">Find a message</h2>
                </div>
                <button type="button" aria-label="Close search" onClick={() => closeSearch(true)}>
                  ×
                </button>
              </header>
              <form onSubmit={submit}>
                <label className="sr-only" htmlFor="workspace-search-query">
                  Search messages
                </label>
                <input
                  id="workspace-search-query"
                  ref={input}
                  type="search"
                  value={query}
                  maxLength={200}
                  autoComplete="off"
                  placeholder="Search channels and direct messages"
                  onChange={(event) => {
                    const nextQuery = event.target.value;
                    setQuery(nextQuery);
                    setError("");
                    if (submittedQuery !== "" && nextQuery.trim() !== submittedQuery) {
                      requestGeneration.current += 1;
                      setSubmittedQuery("");
                      setResults([]);
                      setNextCursor(null);
                      setLoading(false);
                    }
                  }}
                />
                <button type="submit" disabled={loading || query.trim().length < 2}>
                  {loading && nextCursor === null ? "Searching…" : "Search"}
                </button>
              </form>

              {submittedQuery !== "" && !loading && results.length === 0 && error === "" && (
                <div className="search-empty-state">
                  <strong>No messages found</strong>
                  <p>Try another word or phrase.</p>
                </div>
              )}
              {results.length > 0 && (
                <ol className="workspace-search-results">
                  {results.map((result) => {
                    const author = members.find((member) => member.id === result.message.authorId);
                    return (
                      <li key={result.message.id}>
                        <button
                          type="button"
                          onClick={() => {
                            const generation = requestGeneration.current;
                            void openResult(result)
                              .then((opened) => {
                                if (
                                  opened !== false &&
                                  openState.current &&
                                  generation === requestGeneration.current
                                ) {
                                  closeSearch(false);
                                }
                              })
                              .catch((openError: unknown) => {
                                if (openState.current && generation === requestGeneration.current) {
                                  setError(errorMessage(openError));
                                }
                              });
                          }}
                        >
                          <span className="search-result-context">
                            <strong>{conversationName(result.message.conversationId)}</strong>
                            <span>
                              {author?.displayName ?? "Former member"} ·{" "}
                              {resultTime(result.message.createdAt)}
                            </span>
                          </span>
                          <span className="search-result-body">{result.message.body}</span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
              {nextCursor !== null && (
                <button
                  className="search-load-more"
                  type="button"
                  disabled={loading}
                  onClick={() => void run(nextCursor)}
                >
                  {loading ? "Loading…" : "Load more"}
                </button>
              )}
              {error !== "" && (
                <p className="workspace-search-error" role="alert">
                  {error}
                </p>
              )}
            </section>
          </div>,
          document.body,
        )}
    </>
  );
}
