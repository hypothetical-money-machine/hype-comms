import { describe, expect, it } from "vitest";
import { extractGlobalOptions, parseCommandArguments } from "../src/argv.js";

describe("Node argument parsing with CLI policies", () => {
  it("preserves local values, single-dash positionals and the literal delimiter", () => {
    const global = extractGlobalOptions([
      "messages",
      "send",
      "--body=-hello",
      "--profile",
      "work",
      "--json",
      "--",
      "--json",
    ]);
    expect(global.args).toEqual(["messages", "send", "--body=-hello", "--", "--json"]);
    expect(global.options).toMatchObject({ json: true, profile: "work" });
    expect(
      parseCommandArguments(["-query", "--body", "-text", "--", "--json"], {
        body: { kind: "string" },
      }),
    ).toEqual({ positionals: ["-query", "--json"], options: { body: "-text" } });
  });
  it("keeps repeated list values and rejects repeated scalar values and missing values", () => {
    expect(
      parseCommandArguments(["--id=a", "--id", "b"], { id: { kind: "string", multiple: true } })
        .options.id,
    ).toEqual(["a", "b"]);
    expect(() => parseCommandArguments(["--id=a", "--id=b"], { id: { kind: "string" } })).toThrow(
      /only be used once/u,
    );
    expect(() => parseCommandArguments(["--id", "--json"], { id: { kind: "string" } })).toThrow(
      /requires a value/u,
    );
    expect(() => parseCommandArguments(["--json=false"], { json: { kind: "boolean" } })).toThrow(
      /does not accept a value/u,
    );
    expect(() => parseCommandArguments(["--unknown"], {})).toThrow(/Unknown option/u);
  });
  it("rejects duplicate global ownership and unsupported adapter protocols before execution", () => {
    expect(() => extractGlobalOptions(["--profile=a", "--profile=b"])).toThrow(
      /only be used once/u,
    );
    expect(() => extractGlobalOptions(["--adapter-protocol=2"])).toThrow(/adapter protocol 1/u);
    expect(extractGlobalOptions(["--adapter-protocol=1"]).options).toMatchObject({
      adapterProtocol: 1,
      json: true,
    });
  });
});
