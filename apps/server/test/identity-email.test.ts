import { createServer, type Socket } from "node:net";
import {
  createSecureContext,
  createServer as createTlsServer,
  getCACertificates,
  setDefaultCACertificates,
  TLSSocket,
} from "node:tls";

import { emailSchema } from "@hype-comms/contracts";
import nodemailer, { type Transporter } from "nodemailer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConsoleEmailSender, SmtpEmailSender } from "../src/modules/identity/email.js";
import { createTestTlsCertificate } from "./support/tls-certificate.js";

const input = {
  to: emailSchema.parse("member@example.com"),
  url: "https://chat.example/auth/magic-link?token=credential",
  expiresAt: new Date("2026-07-24T12:15:00.000Z"),
};

afterEach(() => {
  vi.restoreAllMocks();
});

type SmtpTransport = "plaintext" | "implicit TLS" | "STARTTLS";

async function createSmtpInbox(transport: SmtpTransport) {
  const certificate = createTestTlsCertificate();
  const secureContext = createSecureContext(certificate);
  const connections = new Set<Socket>();
  const commands: { line: string; encrypted: boolean }[] = [];
  let message = "";
  let secureConnections = 0;
  const trackConnection = (socket: Socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
    // A client rejecting the test certificate can end the handshake with a TLS error.
    socket.on("error", () => undefined);
  };
  const readCommands = (socket: Socket, sendGreeting: boolean) => {
    socket.setEncoding("utf8");
    if (sendGreeting) socket.write("220 localhost SMTP ready\r\n");
    let buffer = "";
    let receivingMessage = false;
    const onData = (chunk: string) => {
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

        const encrypted = socket instanceof TLSSocket;
        commands.push({ line, encrypted });
        const command = line.split(" ", 1)[0]?.toUpperCase();
        switch (command) {
          case "EHLO":
            socket.write(
              transport === "STARTTLS" && !encrypted
                ? "250-localhost\r\n250 STARTTLS\r\n"
                : "250-localhost\r\n250 AUTH PLAIN\r\n",
            );
            break;
          case "STARTTLS":
            socket.removeListener("data", onData);
            socket.write("220 Ready to start TLS\r\n", () => {
              const securedSocket = new TLSSocket(socket, { isServer: true, secureContext });
              trackConnection(securedSocket);
              securedSocket.once("secure", () => {
                secureConnections += 1;
              });
              readCommands(securedSocket, false);
            });
            return;
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
    };
    socket.on("data", onData);
  };
  const server =
    transport === "implicit TLS"
      ? createTlsServer(certificate, (socket) => {
          secureConnections += 1;
          trackConnection(socket);
          readCommands(socket, true);
        })
      : createServer((socket) => {
          trackConnection(socket);
          readCommands(socket, true);
        });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The SMTP test server did not bind a TCP port");
  }
  return {
    certificate,
    commands,
    url: `${transport === "implicit TLS" ? "smtps" : "smtp"}://test-user:test-password@127.0.0.1:${address.port}`,
    get message() {
      return message;
    },
    get secureConnections() {
      return secureConnections;
    },
    async close() {
      for (const socket of connections) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

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

  it.each(["plaintext", "implicit TLS", "STARTTLS"] as const)(
    "authenticates and delivers a magic link over %s",
    async (transport) => {
      const inbox = await createSmtpInbox(transport);
      const defaultCertificates = getCACertificates();
      try {
        if (transport !== "plaintext") {
          setDefaultCACertificates([...defaultCertificates, inbox.certificate.cert]);
        }
        const sender = new SmtpEmailSender({
          url: inbox.url,
          from: "Hype Comms <chat@example.com>",
        });

        await sender.sendMagicLink(input);

        const commands = inbox.commands.map(({ line }) => line);
        expect(commands).toContain(
          `AUTH PLAIN ${Buffer.from("\0test-user\0test-password").toString("base64")}`,
        );
        expect(commands).toContain("MAIL FROM:<chat@example.com>");
        expect(commands).toContain("RCPT TO:<member@example.com>");
        expect(inbox.message).toContain("From: Hype Comms <chat@example.com>\r\n");
        expect(inbox.message).toContain("To: member@example.com\r\n");
        expect(inbox.message).toContain("Subject: Your Hype Comms sign-in link\r\n");
        expect(inbox.message).toContain("Content-Type: text/plain; charset=utf-8\r\n");
        expect(inbox.message).toContain(input.url);
        expect(inbox.message).toContain(input.expiresAt.toISOString());
        expect(inbox.message).not.toContain("text/html");
        expect(inbox.secureConnections).toBe(transport === "plaintext" ? 0 : 1);
        const deliveryCommands = inbox.commands.filter(({ line }) =>
          /^(AUTH |MAIL |RCPT |DATA$)/u.test(line),
        );
        expect(deliveryCommands).toHaveLength(4);
        for (const { encrypted } of deliveryCommands) {
          expect(encrypted).toBe(transport !== "plaintext");
        }
        if (transport === "STARTTLS") {
          expect(commands).toContain("STARTTLS");
          expect(
            inbox.commands
              .filter(({ line }) => /^EHLO /u.test(line))
              .map(({ encrypted }) => encrypted),
          ).toEqual([false, true]);
        }
      } finally {
        setDefaultCACertificates(defaultCertificates);
        await inbox.close();
      }
    },
  );

  it.each(["implicit TLS", "STARTTLS"] as const)(
    "rejects an untrusted %s certificate before sending credentials",
    async (transport) => {
      const inbox = await createSmtpInbox(transport);
      try {
        const sender = new SmtpEmailSender({
          url: inbox.url,
          from: "Hype Comms <chat@example.com>",
        });

        await expect(sender.sendMagicLink(input)).rejects.toThrow(/self[- ]signed certificate/iu);

        expect(inbox.commands.filter(({ line }) => /^AUTH /u.test(line))).toHaveLength(0);
        expect(inbox.message).toBe("");
      } finally {
        await inbox.close();
      }
    },
  );
});
