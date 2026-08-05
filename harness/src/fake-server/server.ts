/**
 * fake-server — local static publishing server (harness-design §1.2).
 *
 * A REAL HTTP static server (node:http, zero deps) that serves a release:
 * manifest.json + artifacts + the two-level signature chain. It is the
 * black-box plane's publishing endpoint — DST's in-memory disk is a
 * separate component (archer, §1.45); this one serves real bytes over a
 * real socket.
 *
 * Tamper API — the supply-chain teeth's whole point is "real tamper ->
 * real reject": corruptByte / swapSig / serveOlderVersion / dropFile all
 * mutate what the client actually downloads, and the teeth verify that a
 * real chain verifier rejects the result. No verification function is
 * mocked anywhere. The on-disk release semantics live in ReleaseStore
 * (store.ts); this file is the HTTP layer over it.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createKeychain, type TestKeychain } from "./keychain.ts";
import { ReleaseStore, type PublishReleaseSpec, type PublishedRelease } from "./store.ts";

export type { PublishReleaseSpec, PublishedRelease };

export interface FakeServerOptions {
  /** Directory that will hold the release store (usually inside a sandbox). */
  storeDir: string;
  /** Keychain for signing; omit to auto-generate one. */
  keychain?: TestKeychain;
  /** Port to bind; omit for an OS-assigned ephemeral port. */
  port?: number;
}

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".pub": "application/x-pem-file",
  ".bin": "application/octet-stream",
  ".sig": "application/octet-stream",
};

export class FakeServer {
  /** The release store backing this server (the factory's publish target). */
  readonly store: ReleaseStore;
  private readonly requestedPort: number | undefined;
  private server: Server | null = null;
  private actualPort = 0;

  constructor(opts: FakeServerOptions) {
    this.store = new ReleaseStore(opts.storeDir, opts.keychain ?? createKeychain());
    this.requestedPort = opts.port;
  }

  get url(): string {
    if (!this.server) throw new Error("FakeServer not started");
    return `http://127.0.0.1:${this.actualPort}`;
  }

  get port(): number {
    return this.actualPort;
  }

  get active(): string | null {
    return this.store.active;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.requestedPort ?? 0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") this.actualPort = addr.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }

  async publishRelease(spec: PublishReleaseSpec): Promise<PublishedRelease> {
    this.requireStarted();
    return this.store.publish(spec);
  }

  async corruptByte(file: string, offset: number): Promise<void> {
    return this.store.corruptByte(file, offset);
  }

  async swapSig(fileA: string, fileB: string): Promise<void> {
    return this.store.swapFiles(fileA, fileB);
  }

  async serveOlderVersion(): Promise<string> {
    return this.store.switchToOlderVersion();
  }

  async dropFile(file: string): Promise<void> {
    return this.store.dropFile(file);
  }

  async restore(): Promise<void> {
    return this.store.restore();
  }

  async readFile(file: string): Promise<Uint8Array> {
    return this.store.readFile(file);
  }

  private requireStarted(): void {
    if (!this.server) throw new Error("FakeServer not started");
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain" }).end("method not allowed");
      return;
    }
    const raw = (req.url ?? "/").split("?")[0] ?? "/";
    let file: string;
    try {
      file = decodeURIComponent(raw).replace(/^\/+/, "");
    } catch {
      res.writeHead(400, { "content-type": "text/plain" }).end("bad request");
      return;
    }
    if (!file) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    let target: string;
    try {
      target = await this.store.resolveFile(file);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    try {
      const data = await fs.readFile(target);
      const ext = path.extname(file).toLowerCase();
      res.writeHead(200, {
        "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "content-length": data.length,
      });
      if (req.method === "GET") res.end(data);
      else res.end();
    } catch {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
    }
  }
}
