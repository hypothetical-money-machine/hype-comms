import {
  emailSchema,
  magicLinkRequestedSchema,
  type Email,
  type MagicLinkRequested,
} from "@hype-comms/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { EmailSender, SendMagicLinkInput } from "../src/modules/identity/email.js";
import type { IdentityRepository } from "../src/modules/identity/repository.js";
import { IdentityService } from "../src/modules/identity/service.js";
import { SignInThrottle } from "../src/throttle.js";

const NOW = new Date("2026-08-22T12:00:00.000Z");
const MEMBER_ID = "10000000-0000-4000-8000-000000000001";
const INVITATION_ID = "10000000-0000-4000-8000-000000000002";

class CapturingEmailSender implements EmailSender {
  readonly sent: SendMagicLinkInput[] = [];

  async sendMagicLink(input: SendMagicLinkInput): Promise<void> {
    this.sent.push(input);
  }
}

function createService(options: {
  readonly throttle: SignInThrottle;
  readonly members?: readonly Email[];
  readonly invitees?: readonly Email[];
}) {
  const members = new Set(options.members ?? []);
  const invitees = new Set(options.invitees ?? []);
  const findUserByEmail = vi.fn(async (email: Email) =>
    members.has(email) ? { id: MEMBER_ID } : null,
  );
  const findActiveMembershipByUserId = vi.fn(async () => ({}));
  const findPendingInvitationByEmail = vi.fn(async (email: Email) =>
    invitees.has(email)
      ? {
          id: INVITATION_ID,
          expiresAt: new Date(NOW.getTime() + 60 * 60_000).toISOString(),
        }
      : null,
  );
  const insertMagicLink = vi.fn(async () => undefined);
  const repository = {
    findUserByEmail,
    findActiveMembershipByUserId,
    findPendingInvitationByEmail,
    insertMagicLink,
  } as unknown as IdentityRepository;
  const sender = new CapturingEmailSender();
  const service = new IdentityService(
    repository,
    sender,
    options.throttle,
    () => NOW,
    "http://127.0.0.1:3000",
  );
  return {
    findPendingInvitationByEmail,
    findUserByEmail,
    sender,
    service,
  };
}

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

describe("magic-link throttle scoping", () => {
  it("does not let one client spend another client's budget for the same email", async () => {
    const email = emailSchema.parse("member@example.com");
    const { sender, service } = createService({
      members: [email],
      throttle: new SignInThrottle({
        maxRequestsPerClient: 10,
        maxRequestsPerEmailPerClient: 2,
        maxDeliveriesPerEmail: 10,
      }),
    });

    const responses: MagicLinkRequested[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      responses.push(await service.requestMagicLink(email, "198.51.100.10"));
    }
    responses.push(await service.requestMagicLink(email, "203.0.113.10"));

    expect(responses).toEqual(
      Array.from({ length: 4 }, () => magicLinkRequestedSchema.parse({ status: "accepted" })),
    );
    expect(sender.sent.map(({ to }) => to)).toEqual([email, email, email]);
  });

  it("caps delivery attempts for one email across clients without charging unknown addresses", async () => {
    const member = emailSchema.parse("member@example.com");
    const unknown = emailSchema.parse("unknown@example.com");
    const { sender, service } = createService({
      members: [member],
      throttle: new SignInThrottle({
        maxRequestsPerClient: 10,
        maxRequestsPerEmailPerClient: 10,
        maxDeliveriesPerEmail: 3,
      }),
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await service.requestMagicLink(unknown, `192.0.2.${attempt + 1}`);
    }
    const responses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      responses.push(await service.requestMagicLink(member, `198.51.100.${attempt + 1}`));
    }

    expect(responses).toEqual(
      Array.from({ length: 5 }, () => magicLinkRequestedSchema.parse({ status: "accepted" })),
    );
    expect(sender.sent.map(({ to }) => to)).toEqual([member, member, member]);
  });

  it("keeps member, invitee, unknown, and throttled HTTP responses byte-identical", async () => {
    const member = emailSchema.parse("member@example.com");
    const invitee = emailSchema.parse("invitee@example.com");
    const unknown = emailSchema.parse("unknown@example.com");
    const { findPendingInvitationByEmail, findUserByEmail, sender, service } = createService({
      members: [member],
      invitees: [invitee],
      throttle: new SignInThrottle({
        maxRequestsPerClient: 10,
        maxRequestsPerEmailPerClient: 1,
        maxDeliveriesPerEmail: 10,
      }),
    });
    const app = await buildApp({ identity: { service } });
    apps.push(app);
    const request = (email: Email) =>
      app.inject({
        method: "POST",
        url: "/v1/auth/magic-link",
        remoteAddress: "198.51.100.10",
        payload: { email },
      });

    const responses = [
      await request(member),
      await request(invitee),
      await request(unknown),
      await request(member),
    ];

    expect(responses.map(({ statusCode }) => statusCode)).toEqual([202, 202, 202, 202]);
    expect(new Set(responses.map(({ body }) => body))).toEqual(
      new Set([JSON.stringify({ status: "accepted" })]),
    );
    expect(sender.sent.map(({ to }) => to)).toEqual([member, invitee]);
    // Even the throttled request resolves recipient state, so the throttle does not introduce an
    // existence-dependent fast path that can be observed separately from the uniform response.
    expect(findUserByEmail).toHaveBeenCalledTimes(4);
    expect(findPendingInvitationByEmail).toHaveBeenCalledTimes(4);
  });
});
