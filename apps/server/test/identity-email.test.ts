import { createServer, type Socket } from "node:net";

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

  it("authenticates and delivers a magic link through the configured SMTP URL", async () => {
    const commands: string[] = [];
    const connections = new Set<Socket>();
    let message = "";
    const server = createServer((socket) => {
      connections.add(socket);
      socket.once("close", () => connections.delete(socket));
      socket.setEncoding("utf8");
      socket.write("220 localhost SMTP ready\r\n");
      let buffer = "";
      let receivingMessage = false;
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let endOfLine: number;
        while ((endOfLine = buffer.indexOf("\r\n")) !== -1) {
          const line = buffer.slice(0, endOfLine);
          buffer = buffer.slice(endOfLine + 2);
          if (receivingMessage) {
            if (line === ".") {
              receivingMessage = false;
              socket.write("250 Message accepted\r\n");
            } else {
              message += `${line}\r\n`;
            }
            continue;
          }

          commands.push(line);
          const command = line.split(" ", 1)[0]?.toUpperCase();
          switch (command) {
            case "EHLO":
              socket.write("250-localhost\r\n250 AUTH PLAIN\r\n");
              break;
            case "AUTH":
              socket.write("235 Authentication successful\r\n");
              break;
            case "MAIL":
            case "RCPT":
              socket.write("250 OK\r\n");
              break;
            case "DATA":
              receivingMessage = true;
              socket.write("354 End with a single dot\r\n");
              break;
            case "QUIT":
              socket.end("221 Goodbye\r\n");
              break;
            default:
              socket.write("502 Unsupported command\r\n");
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (address === null || typeof address === "string") {
        throw new Error("The SMTP test server did not bind a TCP port");
      }
      const sender = new SmtpEmailSender({
        url: `smtp://test-user:test-password@127.0.0.1:${address.port}`,
        from: "Hype Comms <chat@example.com>",
      });

      await sender.sendMagicLink(input);

      expect(commands).toContain(
        `AUTH PLAIN ${Buffer.from("\0test-user\0test-password").toString("base64")}`,
      );
      expect(commands).toContain("MAIL FROM:<chat@example.com>");
      expect(commands).toContain("RCPT TO:<member@example.com>");
      expect(message).toContain("From: Hype Comms <chat@example.com>\r\n");
      expect(message).toContain("To: member@example.com\r\n");
      expect(message).toContain("Subject: Your Hype Comms sign-in link\r\n");
      expect(message).toContain("Content-Type: text/plain; charset=utf-8\r\n");
      expect(message).toContain(input.url);
      expect(message).toContain(input.expiresAt.toISOString());
      expect(message).not.toContain("text/html");
    } finally {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
