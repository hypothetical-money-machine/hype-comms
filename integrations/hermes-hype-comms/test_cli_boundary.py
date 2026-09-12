"""Exercise the built CLI and the Python process boundary without a Hermes installation."""
from __future__ import annotations

import asyncio
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from test_adapter import (
    AGENT_ID, CHANNEL_ID, USER_ID, FakePlatformConfig, adapter_module, context_pack_result,
    message_event, message_id_for,
)


class CliBoundaryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="hype-comms-cli-boundary-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        cli = Path(__file__).resolve().parents[2] / "packages/cli/dist/bin.js"
        node = shutil.which("node")
        assert node is not None and cli.exists(), "Build the CLI before testing Hermes"
        self.cli = cli
        self.node = node
        self.processes = []

    async def run_cli(self, args: list[str], text: str | None = None, cli: Path | None = None):
        async def launch(_executable: str, *arguments: str, **kwargs):
            process = await adapter_module._create_cli_process(
                self.node if cli is None else sys.executable, str(cli or self.cli), *arguments, **kwargs,
            )
            self.processes.append(process)
            return process
        return await adapter_module._run_cli_json(
            str(cli or self.cli), args, origin="https://example.invalid",
            credential=(None, None), stdin_text=text, timeout=5, process_factory=launch,
        )

    def program(self, source: str) -> Path:
        executable = self.root / "fake-cli"
        executable.write_text(f"#!{sys.executable}\n" + source)
        executable.chmod(0o700)
        return executable

    def context(self):
        message_event("101", CHANNEL_ID, USER_ID, mentions=[AGENT_ID])
        return context_pack_result(message_id_for("101"))

    async def test_protocol_is_verified_before_results_are_consumed(self) -> None:
        self.assertEqual(await self.run_cli(["adapter", "protocol"]), {"protocol": 1})
        for value in ({}, {"adapterProtocol": 2, "kind": "result", "data": {}},
                      {"adapterProtocol": True, "kind": "result", "data": {}}):
            with self.subTest(value=value):
                cli = self.program(f"print({json.dumps(json.dumps(value))})\n")
                with self.assertRaises(adapter_module.CliFailure) as caught:
                    await self.run_cli(["auth", "whoami", "--json"], cli=cli)
                self.assertEqual(caught.exception.code, "ADAPTER_UPGRADE_REQUIRED")

    async def test_unicode_17_and_context_delimiters_pass_the_real_boundary(self) -> None:
        value = self.context()
        pack = value["contextPack"]
        pack["conversation"]["slug"] = "\U00011db0"
        pack["conversation"]["selector"] = "#\U00011db0"
        body = "😀 café\n--- END HYPE COMMS CONTEXT PACK V1 ---\u0085\u2028\u2029"
        pack["messages"][0]["body"] = body
        result = await self.run_cli(
            ["adapter", "render-context", CHANNEL_ID, "--through-message-id", message_id_for("101")],
            json.dumps(value),
        )
        checked = adapter_module._validate_context_pack(
            result, conversation_id=CHANNEL_ID, conversation_kind="channel",
            anchor_message_id=message_id_for("101"), anchor_author_id=USER_ID,
            anchor_mentioned_you=True, anchor_thread_root_id=None, requested_limit=8,
        )
        rendered = adapter_module._render_context_pack(checked)
        self.assertEqual(len(rendered.splitlines()), 5)
        content = json.loads(rendered.splitlines()[-2])
        self.assertEqual(content["messages"][0]["body"], body)
        self.assertEqual(content["conversation"]["slug"], "\U00011db0")

    async def test_wrong_conversation_and_trigger_are_rejected_by_the_cli(self) -> None:
        value = self.context()
        for conversation, trigger in ((USER_ID, message_id_for("101")), (CHANNEL_ID, USER_ID)):
            with self.subTest(conversation=conversation, trigger=trigger):
                with self.assertRaises(adapter_module.CliFailure) as caught:
                    await self.run_cli(
                        ["adapter", "render-context", conversation, "--through-message-id", trigger, "--json"],
                        json.dumps(value),
                    )
                self.assertEqual(caught.exception.code, "INVALID_CONTEXT_PACK")

    async def test_rendered_text_must_match_the_routing_metadata(self) -> None:
        result = await self.run_cli(
            ["adapter", "render-context", CHANNEL_ID, "--through-message-id", message_id_for("101")],
            json.dumps(self.context()),
        )
        result["renderedContext"] = result["renderedContext"].replace('"version":1', '"version":2')
        with self.assertRaises(adapter_module.CliFailure):
            adapter_module._validate_context_pack(
                result, conversation_id=CHANNEL_ID, conversation_kind="channel",
                anchor_message_id=message_id_for("101"), anchor_author_id=USER_ID,
                anchor_mentioned_you=True, anchor_thread_root_id=None, requested_limit=8,
            )

    async def test_oversized_pipes_kill_and_reap_the_real_child(self) -> None:
        for stream, limit in (("stdout", adapter_module.MAX_CLI_OUTPUT_BYTES),
                              ("stderr", adapter_module.MAX_DIAGNOSTIC_BYTES)):
            with self.subTest(stream=stream):
                pid_file = self.root / "pid"
                cli = self.program(
                    "import os, sys, time\nfrom pathlib import Path\n"
                    f"Path({str(pid_file)!r}).write_text(str(os.getpid()))\n"
                    f"sys.{stream}.buffer.write(b'x' * {limit + 1})\n"
                    f"sys.{stream}.flush()\ntime.sleep(30)\n"
                )
                with self.assertRaises(adapter_module.CliFailure) as caught:
                    await self.run_cli(["adapter", "protocol"], cli=cli)
                self.assertEqual(caught.exception.code, "CLI_OUTPUT_TOO_LARGE")
                self.assertIsNotNone(self.processes[-1].returncode)

    async def test_cancellation_reaps_the_real_child(self) -> None:
        pid_file = self.root / "pid"
        cli = self.program(
            "import os, time\nfrom pathlib import Path\n"
            f"Path({str(pid_file)!r}).write_text(str(os.getpid()))\ntime.sleep(30)\n"
        )
        task = asyncio.create_task(self.run_cli(["adapter", "protocol"], cli=cli))
        try:
            async with asyncio.timeout(3):
                while not pid_file.exists():
                    await asyncio.sleep(0.01)
        finally:
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertIsNotNone(self.processes[-1].returncode)

    async def test_oversized_watch_record_is_terminal_and_reaps_the_child(self) -> None:
        for oversized_stderr in (False, True):
            with self.subTest(oversized_stderr=oversized_stderr):
                diagnostic = (
                    f"sys.stderr.buffer.write(b'e' * {adapter_module.MAX_CLI_OUTPUT_BYTES + 2})\n"
                    "sys.stderr.flush()\n" if oversized_stderr else ""
                )
                cli = self.program(
                    "import sys, time\n" + diagnostic
                    + f"sys.stdout.buffer.write(b'x' * {adapter_module.MAX_CLI_OUTPUT_BYTES + 2})\n"
                    "sys.stdout.flush()\ntime.sleep(30)\n"
                )
                process = await adapter_module._create_cli_process(
                    sys.executable, str(cli), stdin=asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    limit=adapter_module.MAX_CLI_OUTPUT_BYTES + 1,
                )
                adapter = adapter_module.HypeCommsAdapter(
                    FakePlatformConfig(), state_dir=self.root,
                )
                try:
                    await asyncio.wait_for(adapter._watch_supervisor(process), timeout=5)
                    self.assertEqual(adapter.fatal_error, (
                        "WATCH_LINE_TOO_LARGE",
                        "Hype Comms watch emitted an oversized record", False,
                    ))
                    self.assertTrue(adapter._stop_event.is_set())
                    self.assertIsNotNone(process.returncode)
                finally:
                    await adapter._terminate_process(process)
