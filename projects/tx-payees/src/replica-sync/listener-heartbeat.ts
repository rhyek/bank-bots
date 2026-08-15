/**
 * Liveness probe for the LISTEN connection.
 *
 * A LISTEN-only pg connection never writes, so a silently dropped socket — the Supabase pooler (or a
 * NAT/load balancer in front of it) reaping an idle connection — is never surfaced as an error:
 * node-postgres confirms that both client and server keep believing a silently-dropped connection is
 * alive, so no `error` event ever fires (brianc/node-postgres#2362). The listener then goes deaf
 * without noticing, and every NOTIFY after the drop is lost until the process is restarted.
 *
 * A periodic `SELECT 1` fixes both halves of that:
 *   - it keeps the connection non-idle, so the pooler is far less likely to reap it in the first
 *     place; and
 *   - it is the only reliable way to notice the connection *has* died — TCP keepalive alone is not
 *     enough (same issue thread). A probe that rejects, or that hangs past `probeTimeoutMs` (the
 *     silent-drop case, where the query never settles), means the connection is gone.
 *
 * On the first such failure it reports death exactly once and stops; the owner is expected to tear
 * this down and start a fresh heartbeat against the reconnected client.
 */
export class ListenerHeartbeat {
  private timer?: NodeJS.Timeout;
  private stopped = false;

  constructor(
    private readonly opts: {
      intervalMs: number;
      probeTimeoutMs: number;
      probe: () => Promise<unknown>;
      onDead: (err: Error) => void;
    },
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  // Self-scheduling setTimeout rather than setInterval so a slow probe can never stack: the next
  // beat is armed only after the current one settles.
  private schedule(): void {
    this.timer = setTimeout(() => void this.beat(), this.opts.intervalMs);
    // Don't keep the event loop alive just to heartbeat — the app should be free to exit.
    this.timer.unref();
  }

  private async beat(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      await this.withTimeout(this.opts.probe());
    } catch (err) {
      // A stop() racing in during an in-flight probe (e.g. the owner tearing us down) must not be
      // reported as connection death.
      if (this.stopped) {
        return;
      }
      this.stop();
      this.opts.onDead(err as Error);
      return;
    }
    if (!this.stopped) {
      this.schedule();
    }
  }

  private withTimeout<T>(probe: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`heartbeat probe timed out after ${this.opts.probeTimeoutMs}ms`)),
        this.opts.probeTimeoutMs,
      );
      timer.unref();
      probe.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err as Error);
        },
      );
    });
  }
}
