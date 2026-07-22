export type ReadinessCheck = () => boolean | Promise<boolean>;

export class Lifecycle {
  readonly #checks = new Map<string, ReadinessCheck>();
  #state: "starting" | "ready" | "draining" = "starting";

  addCheck(name: string, check: ReadinessCheck): void {
    if (this.#checks.has(name) || name === "server") {
      throw new Error(`Readiness check already registered: ${name}`);
    }
    this.#checks.set(name, check);
  }

  markReady(): void {
    if (this.#state !== "draining") this.#state = "ready";
  }

  markDraining(): void {
    this.#state = "draining";
  }

  async inspect(): Promise<Record<string, "ok" | "failed">> {
    const checks: Record<string, "ok" | "failed"> = {
      server: this.#state === "ready" ? "ok" : "failed",
    };

    await Promise.all(
      [...this.#checks].map(async ([name, check]) => {
        try {
          checks[name] = (await check()) ? "ok" : "failed";
        } catch {
          checks[name] = "failed";
        }
      }),
    );

    return checks;
  }
}
