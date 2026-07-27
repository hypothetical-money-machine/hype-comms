import type { MessageSearchResponse, MessageSearchResult, User } from "@hmm-chat/contracts";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";

interface WorkspaceSearchProps {
  readonly members: readonly User[];
  readonly conversationName: (conversationId: string) => string;
  readonly search: (query: string, after?: string) => Promise<MessageSearchResponse>;
  readonly openResult: (result: MessageSearchResult) => Promise<void>;
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
}: WorkspaceSearchProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [results, setResults] = useState<readonly MessageSearchResult[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !loading) setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [loading, open]);

  const run = async (after?: string): Promise<void> => {
    const normalized = after === undefined ? query.trim() : submittedQuery;
    if (normalized.length < 2) {
      setError("Enter at least two characters.");
      input.current?.focus();
      return;
    }
    setLoading(true);
    setError("");
    try {
      const response = await search(normalized, after);
      setSubmittedQuery(normalized);
      setResults((current) =>
        after === undefined ? response.results : [...current, ...response.results],
      );
      setNextCursor(response.nextCursor);
    } catch (searchError) {
      setError(errorMessage(searchError));
    } finally {
      setLoading(false);
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void run();
  };

  return (
    <>
      <button className="workspace-search-button" type="button" onClick={() => setOpen(true)}>
        <span aria-hidden="true">⌕</span>
        Search messages
      </button>
      {open &&
        createPortal(
          <div className="dialog-backdrop" onMouseDown={loading ? undefined : () => setOpen(false)}>
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
                <button
                  type="button"
                  aria-label="Close search"
                  disabled={loading}
                  onClick={() => setOpen(false)}
                >
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
                    setQuery(event.target.value);
                    setError("");
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
                          onClick={() =>
                            void openResult(result)
                              .then(() => setOpen(false))
                              .catch((openError: unknown) => setError(errorMessage(openError)))
                          }
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
