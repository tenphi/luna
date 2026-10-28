export function formatTransportError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes('ENOENT') || msg.includes('ECONNREFUSED')) {
    // `bin/luna` cd's to the project root before exec'ing client.ts, so
    // process.cwd() is the install dir — install-slug helpers pick up
    // the right per-checkout suffix.
    return [
      `luna: cannot reach Luna host (${msg}).`,
      `Is the host running? Start it with: pnpm run dev`,
      `Or start the service:`,
      `  luna service start`,
      `  luna service restart`,
      ``,
    ].join('\n');
  }
  return `luna: transport error: ${msg}\n`;
}
