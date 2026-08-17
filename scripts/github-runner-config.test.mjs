import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("supports unique x64 runner identities and an optional organization group", async () => {
  const compose = await readFile(new URL("../docker-compose.runner.yml", import.meta.url), "utf8");
  const entrypoint = await readFile(
    new URL("../.github/runner/entrypoint.sh", import.meta.url),
    "utf8",
  );

  assert.match(
    compose,
    /RUNNER_NAME: \$\{HYPE_COMMS_X64_RUNNER_NAME:-hype-comms-docker-linux-x64\}/u,
  );
  assert.match(
    compose,
    /RUNNER_URL: \$\{HYPE_COMMS_X64_RUNNER_URL:-https:\/\/github\.com\/hype-comms\/hype-comms\}/u,
  );
  assert.match(compose, /RUNNER_GROUP: \$\{HYPE_COMMS_X64_RUNNER_GROUP:-\}/u);
  assert.match(
    compose,
    /RUNNER_LABELS: \$\{HYPE_COMMS_X64_RUNNER_LABELS:-hype-comms-release,docker\}/u,
  );

  assert.match(entrypoint, /config_args=\(/u);
  assert.match(entrypoint, /if \[\[ -n "\$\{RUNNER_GROUP:-\}" \]\]; then/u);
  assert.match(entrypoint, /config_args\+=\(--runnergroup "\$RUNNER_GROUP"\)/u);
  assert.match(entrypoint, /\.\/config\.sh "\$\{config_args\[@\]\}"/u);
});
