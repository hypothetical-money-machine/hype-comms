import { randomUUID } from "node:crypto";

import type {
  CreateDevelopmentWelcomeMessageRequest,
  DevelopmentWelcomeHistory,
  DevelopmentWelcomeMessage,
} from "@hmm-chat/contracts";

const MAX_MESSAGES = 200;

export class DevelopmentMessageConflictError extends Error {
  constructor() {
    super("The client message ID was already used for different content");
    this.name = "DevelopmentMessageConflictError";
  }
}

export interface DevelopmentWelcomeMessageResult {
  readonly message: DevelopmentWelcomeMessage;
  readonly created: boolean;
}

export type DevelopmentWelcomeMessageListener = (message: DevelopmentWelcomeMessage) => void;

export class DevelopmentWelcomeStore {
  readonly #messages: DevelopmentWelcomeMessage[] = [];
  readonly #messagesByClientId = new Map<string, DevelopmentWelcomeMessage>();
  readonly #listeners = new Set<DevelopmentWelcomeMessageListener>();

  history(): DevelopmentWelcomeHistory {
    return { messages: [...this.#messages] };
  }

  create(input: CreateDevelopmentWelcomeMessageRequest): DevelopmentWelcomeMessageResult {
    const existing = this.#messagesByClientId.get(input.clientMessageId);
    if (existing !== undefined) {
      if (existing.authorName !== input.authorName || existing.body !== input.body) {
        throw new DevelopmentMessageConflictError();
      }
      return { message: existing, created: false };
    }

    const createdAt = new Date().toISOString();
    const message: DevelopmentWelcomeMessage = {
      id: randomUUID(),
      clientMessageId: input.clientMessageId,
      authorName: input.authorName,
      body: input.body,
      createdAt,
    };

    this.#messages.push(message);
    this.#messagesByClientId.set(message.clientMessageId, message);

    if (this.#messages.length > MAX_MESSAGES) {
      const removed = this.#messages.shift();
      if (removed !== undefined) {
        this.#messagesByClientId.delete(removed.clientMessageId);
      }
    }

    for (const listener of this.#listeners) {
      listener(message);
    }

    return { message, created: true };
  }

  subscribe(listener: DevelopmentWelcomeMessageListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
}
