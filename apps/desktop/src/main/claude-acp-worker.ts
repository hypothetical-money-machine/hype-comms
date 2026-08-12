import type {
  AgentContext,
  AnyMessage,
  CompleteElicitationNotification,
  CreateElicitationRequest,
  CreateElicitationResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  Stream,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";

const MAX_ACP_MESSAGE_BYTES = 16 * 1_024 * 1_024;

interface AcpEnvelope {
  readonly type: "acp";
  readonly message: AnyMessage;
}

function isBoundedAcpEnvelope(value: unknown): value is AcpEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).length !== 2 ||
    candidate.type !== "acp" ||
    typeof candidate.message !== "object" ||
    candidate.message === null ||
    Array.isArray(candidate.message)
  ) {
    return false;
  }
  try {
    return Buffer.byteLength(JSON.stringify(candidate.message), "utf8") <= MAX_ACP_MESSAGE_BYTES;
  } catch {
    return false;
  }
}

class ClaudeAgentClientBridge {
  constructor(private readonly context: AgentContext) {}

  sessionUpdate(params: SessionNotification): Promise<void> {
    return this.context.notify("session/update", params);
  }

  requestPermission(
    params: RequestPermissionRequest,
    signal?: AbortSignal,
  ): Promise<RequestPermissionResponse> {
    return this.context.request("session/request_permission", params, {
      ...(signal === undefined ? {} : { cancellationSignal: signal }),
    });
  }

  readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    return this.context.request("fs/read_text_file", params);
  }

  writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    return this.context.request("fs/write_text_file", params);
  }

  unstable_createElicitation(
    params: CreateElicitationRequest,
    signal?: AbortSignal,
  ): Promise<CreateElicitationResponse> {
    return this.context.request("elicitation/create", params, {
      ...(signal === undefined ? {} : { cancellationSignal: signal }),
    });
  }

  unstable_completeElicitation(params: CompleteElicitationNotification): Promise<void> {
    return this.context.notify("elicitation/complete", params);
  }

  extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    return this.context.notify(method, params);
  }
}

async function start(): Promise<void> {
  const parentPort = process.parentPort;
  if (parentPort === null || parentPort === undefined) {
    throw new Error("Claude ACP worker requires an Electron utility-process parent");
  }

  const [{ agent: createAgent, methods }, { ClaudeAcpAgent }] = await Promise.all([
    import("@agentclientprotocol/sdk"),
    import("@agentclientprotocol/claude-agent-acp"),
  ]);

  let inputController: ReadableStreamDefaultController<AnyMessage> | null = null;
  const stream: Stream = {
    readable: new ReadableStream<AnyMessage>({
      start(controller) {
        inputController = controller;
      },
    }),
    writable: new WritableStream<AnyMessage>({
      write(message) {
        const envelope: AcpEnvelope = { type: "acp", message };
        if (!isBoundedAcpEnvelope(envelope)) {
          throw new Error("ACP message exceeds the utility-process limit");
        }
        parentPort.postMessage(envelope);
      },
    }),
  };

  parentPort.on("message", (event) => {
    if (!isBoundedAcpEnvelope(event.data)) {
      inputController?.error(new Error("Invalid ACP utility-process message"));
      return;
    }
    inputController?.enqueue(event.data.message);
  });

  const agentState: { current: InstanceType<typeof ClaudeAcpAgent> | null } = { current: null };
  const currentAgent = (): InstanceType<typeof ClaudeAcpAgent> => {
    if (agentState.current === null) throw new Error("Claude ACP connection is not ready");
    return agentState.current;
  };

  const app = createAgent({ name: "hype-comms-claude-agent" })
    .onConnect((connection) => {
      agentState.current = new ClaudeAcpAgent(new ClaudeAgentClientBridge(connection.client), {
        // Adapter diagnostics can include paths or provider details. The parent deliberately gets
        // only a curated process-exit signal, never worker log content.
        log: () => undefined,
        error: () => undefined,
      });
    })
    .onRequest(methods.agent.initialize, (context) => currentAgent().initialize(context.params))
    .onRequest(methods.agent.session.new, (context) => currentAgent().newSession(context.params))
    .onRequest(methods.agent.session.load, (context) => currentAgent().loadSession(context.params))
    .onRequest(methods.agent.session.close, (context) =>
      currentAgent().closeSession(context.params),
    )
    .onRequest(methods.agent.session.setMode, (context) =>
      currentAgent().setSessionMode(context.params),
    )
    .onRequest(methods.agent.session.setConfigOption, (context) =>
      currentAgent().setSessionConfigOption(context.params),
    )
    .onRequest(methods.agent.session.prompt, async (context) => {
      const onAbort = (): void => {
        void currentAgent().cancel({ sessionId: context.params.sessionId });
      };
      context.signal.addEventListener("abort", onAbort, { once: true });
      try {
        return await currentAgent().prompt(context.params);
      } finally {
        context.signal.removeEventListener("abort", onAbort);
      }
    })
    .onNotification(methods.agent.session.cancel, (context) =>
      currentAgent().cancel(context.params),
    );

  const connection = app.connect(stream);
  await connection.closed;
  await agentState.current?.dispose();
}

void start().catch(() => {
  process.exitCode = 1;
});
