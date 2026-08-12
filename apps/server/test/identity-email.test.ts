import { emailSchema } from "@hype-comms/contracts";
import nodemailer, { type Transporter } from "nodemailer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleEmailSender, SmtpEmailSender } from "../src/modules/identity/email.js";

const input = {
  to: emailSchema.parse("member@example.com"),
  url: "https://chat.example/auth/magic-link?token=credential",
  expiresAt: new Date("2026-07-24T12:15:00.000Z"),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("identity email senders", () => {
  it("refuses to construct the credential-logging sender in production", () => {
    expect(() => new ConsoleEmailSender("production")).toThrow(
      "ConsoleEmailSender cannot be used in production",
    );
  });

  it("writes a plain-text development message to the console", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await new ConsoleEmailSender("development").sendMagicLink(input);

    expect(log).toHaveBeenCalledWith(expect.stringContaining(input.url));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(input.expiresAt.toISOString()));
  });

  it("sends a plain-text SMTP message without an HTML alternative", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    vi.spyOn(nodemailer, "createTransport").mockReturnValue({
      sendMail,
    } as unknown as Transporter);
    const sender = new SmtpEmailSender({
      url: "smtp://mail.example.com:2525",
      from: "Hype Comms <chat@example.com>",
    });

    await sender.sendMagicLink(input);

    expect(sendMail).toHaveBeenCalledWith({
      from: "Hype Comms <chat@example.com>",
      to: "member@example.com",
      subject: "Your Hype Comms sign-in link",
      text: expect.stringContaining(input.url),
    });
    expect(sendMail.mock.calls[0]?.[0]).not.toHaveProperty("html");
  });
});
