/** Type surface for tests/e2e/fixtures/static-server.mjs (kept beside the script). */

export interface StaticServer {
  readonly origin: string;
  readonly mountPath: string;
  setRoot(dir: string): void;
  setFailingSw(failing: boolean): void;
  listen(): Promise<void>;
  close(): Promise<void>;
}

export function createStaticServer(options: {
  readonly mountPath: string;
  readonly port: number;
}): StaticServer;
