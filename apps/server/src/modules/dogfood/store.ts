import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  dogfoodMessageSchema,
  type CreateDogfoodMessageRequest,
  type DogfoodHistory,
  type DogfoodMessage,
} from "@hmm-chat/contracts";

const MAX_MESSAGES = 200;

export class DogfoodMessageConflictError extends Error {
  constructor() {
    super("The client message ID was already used for different content");
    this.name = "DogfoodMessageConflictError";
  }
}

export interface DogfoodMessageResult {
  readonly message: DogfoodMessage;
  readonly created: boolean;
}

export class DogfoodChatStore {
  readonly #database: DatabaseSync;
  readonly #listeners = new Set<(message: DogfoodMessage) => void>();

  constructor(filename: string) {
    if (filename !== ":memory:") {
      mkdirSync(path.dirname(filename), { recursive: true });
    }
    this.#database = new DatabaseSync(filename);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS dogfood_messages (
        id TEXT PRIMARY KEY,
        client_message_id TEXT NOT NULL UNIQUE,
        author_name TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  history(): DogfoodHistory {
    const rows = this.#database
      .prepare(
        `SELECT id, client_message_id AS clientMessageId, author_name AS authorName,
                body, created_at AS createdAt
           FROM dogfood_messages
          ORDER BY created_at DESC, id DESC
          LIMIT ?`,
      )
      .all(MAX_MESSAGES);
    return { messages: rows.reverse().map((row) => dogfoodMessageSchema.parse(row)) };
  }

  create(authorName: string, input: CreateDogfoodMessageRequest): DogfoodMessageResult {
    const existing = this.#database
      .prepare(
        `SELECT id, client_message_id AS clientMessageId, author_name AS authorName,
                body, created_at AS createdAt
           FROM dogfood_messages
          WHERE client_message_id = ?`,
      )
      .get(input.clientMessageId);
    if (existing !== undefined) {
      const message = dogfoodMessageSchema.parse(existing);
      if (message.authorName !== authorName || message.body !== input.body) {
        throw new DogfoodMessageConflictError();
      }
      return { message, created: false };
    }

    const message = dogfoodMessageSchema.parse({
      id: randomUUID(),
      clientMessageId: input.clientMessageId,
      authorName,
      body: input.body,
      createdAt: new Date().toISOString(),
    });
    this.#database
      .prepare(
        `INSERT INTO dogfood_messages (id, client_message_id, author_name, body, created_at)
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

  subscribe(listener: (message: DogfoodMessage) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close(): void {
    this.#database.close();
  }
}
