import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { signalProcessTree } from "./process-tree.mjs";

test("signals a detached POSIX process group", async () => {
  const signals = [];
  await signalProcessTree({ exitCode: null, pid: 1234 }, "SIGTERM", {
    platform: "darwin",
    killProcess: (pid, signal) => {
      signals.push([pid, signal]);
    },
  });
  assert.deepEqual(signals, [[-1234, "SIGTERM"]]);
});

test("uses taskkill to terminate an entire Windows process tree", async () => {
  const calls = [];
  await signalProcessTree({ exitCode: null, pid: 4321 }, "SIGTERM", {
    platform: "win32",
    spawnProcess: (command, arguments_, options) => {
      calls.push([command, arguments_, options]);
      const taskkill = new EventEmitter();
      queueMicrotask(() => taskkill.emit("close", 0));
      return taskkill;
    },
  });
  assert.deepEqual(calls, [
    ["taskkill", ["/pid", "4321", "/T"], { stdio: "ignore", windowsHide: true }],
  ]);
});

test("forces a Windows process tree only during the escalation phase", async () => {
  let arguments_;
  await signalProcessTree({ exitCode: null, pid: 4321 }, "SIGKILL", {
    platform: "win32",
    spawnProcess: (_command, receivedArguments) => {
      arguments_ = receivedArguments;
      const taskkill = new EventEmitter();
      queueMicrotask(() => taskkill.emit("close", 0));
      return taskkill;
    },
  });
  assert.deepEqual(arguments_, ["/pid", "4321", "/T", "/F"]);
});

test("does not signal an already exited process", async () => {
  let called = false;
  await signalProcessTree({ exitCode: 0, pid: 4321 }, "SIGTERM", {
    killProcess: () => {
      called = true;
    },
  });
  assert.equal(called, false);
});
