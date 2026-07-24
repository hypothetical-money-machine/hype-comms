import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  chatMessageSchema,
  type CreateChatMessageRequest,
  type ChatHistory,
  type ChatMessage,
} from "@hmm-chat/contracts";

const MAX_MESSAGES = 200;
const SESSION_KEY_NAME = "session_signing_key";
const SESSION_KEY_BYTES = 32;

export class ChatMessageConflictError extends Error {
  constructor() {
    super("The client message ID was already used for different content");
    this.name = "ChatMessageConflictError";
  }
}

export interface ChatMessageResult {
  readonly message: ChatMessage;
  readonly created: boolean;
}

export class ChatStore {
  readonly #database: DatabaseSync;
  readonly #listeners = new Set<(message: ChatMessage) => void>();
  #closed = false;
  /**
   * Server-held secret used to sign session cookies. It is generated on first boot and persisted
   * beside the messages so that restarts do not sign every user out. Keeping it out of the
   * configuration is deliberate: the access code is shared between users, so signing with the
   * access code would let any user who knows it mint a cookie for any other user's name.
   */
  readonly sessionKey: Buffer;

  constructor(filename: string) {
    if (filename !== ":memory:") {
      mkdirSync(path.dirname(filename), { recursive: true });
    }
    this.#database = new DatabaseSync(filename);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        client_message_id TEXT NOT NULL UNIQUE,
        author_name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chat_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.sessionKey = this.#ensureSessionKey();
  }

  #ensureSessionKey(): Buffer {
    const existing = this.#database
      .prepare(`SELECT value FROM chat_metadata WHERE key = ?`)
      .get(SESSION_KEY_NAME);
    if (existing !== undefined && typeof existing.value === "string") {
      const decoded = Buffer.from(existing.value, "base64");
      if (decoded.byteLength === SESSION_KEY_BYTES) return decoded;
    }

    const created = randomBytes(SESSION_KEY_BYTES);
    this.#database
      .prepare(
        `INSERT INTO chat_metadata (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(SESSION_KEY_NAME, created.toString("base64"));
    return created;
  }

  history(): ChatHistory {
    const rows = this.#database
      .prepare(
        `SELECT id, client_message_id AS clientMessageId, author_name AS authorName,
                body, created_at AS createdAt
           FROM chat_messages
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(MAX_MESSAGES);
    return { messages: rows.reverse().map((row) => chatMessageSchema.parse(row)) };
  }

  create(authorName: string, input: CreateChatMessageRequest): ChatMessageResult {
    const existing = this.#database
      .prepare(
        `SELECT id, client_message_id AS clientMessageId, author_name AS authorName,
                body, created_at AS createdAt
           FROM chat_messages
          WHERE client_message_id = ?`,
      )
      .get(input.clientMessageId);
    if (existing !== undefined) {
      const message = chatMessageSchema.parse(existing);
      if (message.authorName !== authorName || message.body !== input.body) {
        throw new ChatMessageConflictError();
      }
      return { message, created: false };
    }

    const message = chatMessageSchema.parse({
      id: randomUUID(),
      clientMessageId: input.clientMessageId,
      authorName,
      body: input.body,
      createdAt: new Date().toISOString(),
    });
    this.#database
      .prepare(
        `INSERT INTO chat_messages (id, client_message_id, author_name, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.clientMessageId,
        message.authorName,
        message.body,
        message.createdAt,
      );

    for (const listener of this.#listeners) listener(message);
    return { message, created: true };
  }

  subscribe(listener: (message: ChatMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#listeners.clear();
    this.#database.close();
  }
}
