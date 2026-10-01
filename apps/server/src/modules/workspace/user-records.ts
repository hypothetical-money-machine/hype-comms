import { userSchema } from "@hype-comms/contracts";
import type { QueryResultRow } from "pg";
import { iso } from "./records.js";

export interface UserRow extends QueryResultRow {
  id: string;
  kind: "human" | "bot" | "agent";
  username: string;
  display_name: string;
  avatar_url: string | null;
  title: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export function mapUser(row: UserRow) {
  return userSchema.parse({
    id: row.id,
    // Agent administration and self-authentication expose the distinct `agent` principal kind,
    // but workspace member projections stay readable by the immediately previous desktop schema
    // (`human | bot`). Existing clients already treated these non-email members as ordinary
    // mention/DM targets, which is exactly the behavior this directory shape needs.
    kind: row.kind === "agent" ? "human" : row.kind,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    title: row.title,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}
