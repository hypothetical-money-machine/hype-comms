import type { Email } from "@hmm-chat/contracts";
import nodemailer, { type Transporter } from "nodemailer";

export interface SendMagicLinkInput {
  readonly to: Email;
  readonly url: string;
  readonly expiresAt: Date;
}

export interface EmailSender {
  sendMagicLink(input: SendMagicLinkInput): Promise<void>;
}

function magicLinkBody(input: SendMagicLinkInput): string {
  return [
    "Use this single-use link to sign in to HMM Chat:",
    "",
    input.url,
    "",
    `This link expires at ${input.expiresAt.toISOString()}.`,
    "If you did not request it, you can ignore this message.",
  ].join("\n");
}

export class ConsoleEmailSender implements EmailSender {
  constructor(nodeEnv: "development" | "test" | "production") {
    if (nodeEnv === "production") {
      throw new Error("ConsoleEmailSender cannot be used in production");
    }
  }

  async sendMagicLink(input: SendMagicLinkInput): Promise<void> {
    console.info(magicLinkBody(input));
  }
}

/**
 * Used when sign-in links are delivered by an administrator instead of by email — the operator
 * runs the invite command and passes the link along privately. It refuses to be called rather
 * than discarding a link silently: with manual delivery the self-service endpoint is disabled, so
 * reaching this sender means something is wired wrong.
 */
export class ManualEmailSender implements EmailSender {
  async sendMagicLink(): Promise<void> {
    throw new Error(
      "Email delivery is set to manual. Issue sign-in links with the invite command instead.",
    );
  }
}

export interface SmtpEmailSenderOptions {
  readonly url: string;
  readonly from: string;
}

export class SmtpEmailSender implements EmailSender {
  readonly #from: string;
  readonly #transporter: Transporter;

  constructor(options: SmtpEmailSenderOptions) {
    this.#from = options.from;
    this.#transporter = nodemailer.createTransport(options.url);
  }

  async sendMagicLink(input: SendMagicLinkInput): Promise<void> {
    await this.#transporter.sendMail({
      from: this.#from,
      to: input.to,
      subject: "Your HMM Chat sign-in link",
      text: magicLinkBody(input),
    });
  }
}
