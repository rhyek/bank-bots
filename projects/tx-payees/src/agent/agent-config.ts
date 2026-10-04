/** How long an agent may stay silent before its session is closed. See runStructuredAgent. */
export function idleTimeoutMs(): number {
  return Number(process.env.TX_AI_IDLE_TIMEOUT_MS ?? 120_000);
}
