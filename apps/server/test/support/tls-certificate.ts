import { generateKeyPairSync, sign } from "node:crypto";

function der(tag: number, ...parts: Buffer[]): Buffer {
  const content = Buffer.concat(parts);
  const lengthBytes: number[] = [];
  for (let length = content.length; length > 0; length >>>= 8) {
    lengthBytes.unshift(length & 0xff);
  }
  const length =
    content.length < 128
      ? Buffer.from([content.length])
      : Buffer.from([0x80 | lengthBytes.length, ...lengthBytes]);
  return Buffer.concat([Buffer.from([tag]), length, content]);
}

/** Generates a short-lived localhost certificate without storing a test private key in Git. */
export function createTestTlsCertificate() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const signatureAlgorithm = der(0x30, der(0x06, Buffer.from("2a8648ce3d040302", "hex")));
  const name = der(
    0x30,
    der(
      0x31,
      der(0x30, der(0x06, Buffer.from("550403", "hex")), der(0x0c, Buffer.from("localhost"))),
    ),
  );
  const time = (timestamp: number) =>
    der(0x18, Buffer.from(new Date(timestamp).toISOString().replace(/[-:T]|\.\d{3}/gu, "")));
  const extensions = der(
    0xa3,
    der(
      0x30,
      // A self-signed test CA, trusted only for the duration of the test.
      der(
        0x30,
        der(0x06, Buffer.from("551d13", "hex")),
        der(0x01, Buffer.from([0xff])),
        der(0x04, der(0x30, der(0x01, Buffer.from([0xff])))),
      ),
      der(
        0x30,
        der(0x06, Buffer.from("551d11", "hex")),
        der(
          0x04,
          der(0x30, der(0x82, Buffer.from("localhost")), der(0x87, Buffer.from([127, 0, 0, 1]))),
        ),
      ),
    ),
  );
  const now = Date.now();
  const body = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.from([1])),
    signatureAlgorithm,
    name,
    der(0x30, time(now - 86_400_000), time(now + 86_400_000)),
    name,
    publicKey.export({ type: "spki", format: "der" }),
    extensions,
  );
  const certificate = der(
    0x30,
    body,
    signatureAlgorithm,
    der(0x03, Buffer.from([0]), sign("sha256", body, privateKey)),
  );
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").replace(/(.{64})(?=.)/gu, "$1\n")}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}
