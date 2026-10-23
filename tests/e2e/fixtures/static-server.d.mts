/** Type surface for tests/e2e/fixtures/static-server.mjs (kept beside the script). */

export interface StaticServer {
  readonly origin: string;
  readonly mountPath: string;
  setRoot(dir: string): void;
  setFailingSw(failing: boolean): void;
  /** Degraded-network probes: fail every response (not just `sw.js`). */
  setFailingAll(failing: boolean): void;
  /** Degraded-network probes: artificial per-response latency in ms (0 = off). */
  setLatency(ms: number): void;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createStaticServer(options: {
  readonly mountPath: string;
  readonly port: number;
}): StaticServer;
