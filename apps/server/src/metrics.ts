interface DatabasePoolMetrics {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

interface HttpMetricLabels {
  readonly method: string;
  readonly route: string;
  readonly statusCode: number;
}

interface HttpMetricSample extends HttpMetricLabels {
  count: number;
  durationSeconds: number;
}

function label(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"');
}

export class MetricsRegistry {
  readonly #http = new Map<string, HttpMetricSample>();
  #realtimeConnections = 0;

  constructor(private readonly databasePool?: DatabasePoolMetrics) {}

  observeHttpRequest(input: HttpMetricLabels & { readonly durationMs: number }): void {
    const key = `${input.method}\u0000${input.route}\u0000${input.statusCode}`;
    const sample = this.#http.get(key) ?? {
      method: input.method,
      route: input.route,
      statusCode: input.statusCode,
      count: 0,
      durationSeconds: 0,
    };
    sample.count += 1;
    sample.durationSeconds += Math.max(input.durationMs, 0) / 1_000;
    this.#http.set(key, sample);
  }

  realtimeConnected(): void {
    this.#realtimeConnections += 1;
  }

  realtimeDisconnected(): void {
    this.#realtimeConnections = Math.max(0, this.#realtimeConnections - 1);
  }

  render(): string {
    const lines = [
      "# HELP hmm_chat_http_requests_total Completed HTTP requests.",
      "# TYPE hmm_chat_http_requests_total counter",
    ];
    const samples = [...this.#http.values()].sort((left, right) =>
      `${left.method}:${left.route}:${left.statusCode}`.localeCompare(
        `${right.method}:${right.route}:${right.statusCode}`,
      ),
    );
    for (const sample of samples) {
      const labels =
        `{method="${label(sample.method)}",route="${label(sample.route)}",` +
        `status_code="${sample.statusCode}"}`;
      lines.push(`hmm_chat_http_requests_total${labels} ${sample.count}`);
    }
    lines.push(
      "# HELP hmm_chat_http_request_duration_seconds HTTP request duration.",
      "# TYPE hmm_chat_http_request_duration_seconds summary",
    );
    for (const sample of samples) {
      const labels =
        `{method="${label(sample.method)}",route="${label(sample.route)}",` +
        `status_code="${sample.statusCode}"}`;
      lines.push(
        `hmm_chat_http_request_duration_seconds_sum${labels} ${sample.durationSeconds}`,
        `hmm_chat_http_request_duration_seconds_count${labels} ${sample.count}`,
      );
    }
    lines.push(
      "# HELP hmm_chat_realtime_connections Current authenticated realtime connections.",
      "# TYPE hmm_chat_realtime_connections gauge",
      `hmm_chat_realtime_connections ${this.#realtimeConnections}`,
    );
    if (this.databasePool !== undefined) {
      lines.push(
        "# HELP hmm_chat_postgres_pool_connections PostgreSQL pool connections by state.",
        "# TYPE hmm_chat_postgres_pool_connections gauge",
        `hmm_chat_postgres_pool_connections{state="total"} ${this.databasePool.totalCount}`,
        `hmm_chat_postgres_pool_connections{state="idle"} ${this.databasePool.idleCount}`,
        `hmm_chat_postgres_pool_connections{state="waiting"} ${this.databasePool.waitingCount}`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
}
