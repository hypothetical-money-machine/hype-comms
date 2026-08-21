import { useEffect, useState } from "react";

import type { CommunicationPath, CommunicationPathsResponse, User } from "@hype-comms/contracts";

import type { DesktopApi } from "../../shared/desktop-api";

export type CommunicationPathsClient = Pick<DesktopApi, "getCommunicationPaths">;

type LoadState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "ready"; readonly data: CommunicationPathsResponse };

function memberName(members: readonly User[], memberId: string): string {
  return members.find((member) => member.id === memberId)?.displayName ?? "Former member";
}

function formatActivity(value: string | null): string {
  if (value === null) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function totalPathActivity(path: CommunicationPath): number {
  return path.directMessageCount + path.sharedChannelCount + path.channelMessageCount;
}

function PathRow({
  path,
  members,
}: {
  readonly path: CommunicationPath;
  readonly members: readonly User[];
}) {
  return (
    <tr>
      <td>{memberName(members, path.memberAId)}</td>
      <td>{memberName(members, path.memberBId)}</td>
      <td className="communication-paths-number">{path.directMessageCount}</td>
      <td className="communication-paths-number">{path.sharedChannelCount}</td>
      <td className="communication-paths-number">{path.channelMessageCount}</td>
      <td className="communication-paths-number">{totalPathActivity(path)}</td>
      <td>
        {path.lastActivityAt === null ? (
          "Never"
        ) : (
          <time dateTime={path.lastActivityAt}>{formatActivity(path.lastActivityAt)}</time>
        )}
      </td>
    </tr>
  );
}

export function CommunicationPathsView({
  client,
  members,
  active,
}: {
  readonly client: CommunicationPathsClient;
  readonly members: readonly User[];
  readonly active: boolean;
}) {
  const [state, setState] = useState<LoadState>({ status: "idle" });

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setState({ status: "loading" });
    client
      .getCommunicationPaths()
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: "error",
            message: error instanceof Error && error.message !== "" ? error.message : "",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [active, client]);

  const paths = state.status === "ready" ? state.data.paths : [];

  return (
    <section
      className="communication-paths-view"
      aria-labelledby="communication-paths-title"
      hidden={!active}
      data-testid="communication-paths-view"
    >
      <header className="unreads-header">
        <div>
          <h2 id="communication-paths-title">Communication paths</h2>
          <p className="unreads-subtitle">
            How members talk to each other: direct messages, shared channels, and channel message
            volume per pair. Owner-only.
          </p>
        </div>
      </header>
      <div className="communication-paths-body">
        {state.status === "loading" && <p role="status">Loading communication paths…</p>}
        {state.status === "error" && (
          <p role="alert">
            {state.message === ""
              ? "Could not load communication paths."
              : `Could not load communication paths: ${state.message}`}
          </p>
        )}
        {state.status === "ready" && paths.length === 0 && (
          <div className="empty-state">
            <h3>No communication yet</h3>
            <p>Once members exchange messages, their paths appear here.</p>
          </div>
        )}
        {state.status === "ready" && paths.length > 0 && (
          <table className="communication-paths-table">
            <thead>
              <tr>
                <th scope="col">Member</th>
                <th scope="col">Communicates with</th>
                <th scope="col" className="communication-paths-number">
                  DMs
                </th>
                <th scope="col" className="communication-paths-number">
                  Shared channels
                </th>
                <th scope="col" className="communication-paths-number">
                  Channel messages
                </th>
                <th scope="col" className="communication-paths-number">
                  Total activity
                </th>
                <th scope="col">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {paths.map((path) => (
                <PathRow
                  key={`${path.memberAId}:${path.memberBId}`}
                  path={path}
                  members={members}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
