/**
 * ReleaseStore — on-disk release store behind the fake-server: publish
 * (manifest + artifacts + two-level signature chain), pristine copies,
 * file-level tamper ops and version switching. Pure filesystem semantics,
 * no HTTP; the FakeServer in server.ts is the HTTP layer over this.
 *
 * Tamper ops mutate the served files on disk (a compromised server's files
 * ARE what the client gets); restore() regenerates from pristine.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { signData, type TestKeychain } from "./keychain.ts";
import {
  MANIFEST_FILE,
  SIGNING_PUB_FILE,
  SIGNING_PUB_SIG_FILE,
  sigFileFor,
  buildManifest,
  sha256Hex,
  compareVersions,
  type Manifest,
} from "./manifest.ts";

export interface PublishReleaseSpec {
  version: string;
  /** Logical artifact name -> content; served at /<name>. */
  artifacts: Record<string, string | Uint8Array>;
  /** Platform tag for the manifest target. Default: "current". */
  platform?: string;
  /** Which artifact is the binary for `platform`. Default: the sole artifact. */
  binary?: string;
  /** Default true: the new release becomes the active (served) one. */
  makeActive?: boolean;
  /** chmod +x every artifact file (real binaries need to be runnable). */
  executable?: boolean;
  /** Track the release is published under (latest | alpha). Optional. */
}

export interface PublishedRelease {
  version: string;
  /** All files served for this release (relative paths). */
  files: string[];
  manifest: Manifest;
}

export class ReleaseStore {
  private readonly storeDir: string;
  private readonly keychain: TestKeychain;
  private activeVersion: string | null = null;
  /** version -> file -> pristine bytes, for restore(). */
  private readonly pristine = new Map<string, Map<string, Uint8Array>>();

  constructor(storeDir: string, keychain: TestKeychain) {
    this.storeDir = storeDir;
    this.keychain = keychain;
  }

  get active(): string | null {
    return this.activeVersion;
  }

  /** Whether a release with this version has been published. */
  has(version: string): boolean {
    return this.pristine.has(version);
  }

  /**
   * Publish a release into the store: writes artifacts + manifest + the
   * full signature chain, and makes it the active release (unless
   * makeActive is false).
   */
  async publish(spec: PublishReleaseSpec): Promise<PublishedRelease> {
    const version = spec.version;
    if (this.pristine.has(version)) {
      throw new Error(`release ${version} already published`);
    }
    const artifactNames = Object.keys(spec.artifacts);
    if (artifactNames.length === 0) throw new Error("release has no artifacts");
    const binary = spec.binary ?? (artifactNames.length === 1 ? artifactNames[0] : undefined);
    if (!binary) throw new Error("multiple artifacts: specify which one is the platform binary");
    if (!artifactNames.includes(binary)) throw new Error(`binary ${binary} not among artifacts`);

    const releaseDir = this.releaseDir(version);
    await fs.mkdir(releaseDir, { recursive: true });

    const bytes = new Map<string, Uint8Array>();
    const targets: Manifest["targets"] = {};
    for (const name of artifactNames) {
      const content = spec.artifacts[name];
      if (content === undefined) throw new Error(`artifact ${name} has no content`);
      const data = typeof content === "string" ? new TextEncoder().encode(content) : content;
      bytes.set(name, data);
      await fs.writeFile(path.join(releaseDir, name), data);
    }
    if (spec.executable) {
      for (const name of artifactNames) {
        await fs.chmod(path.join(releaseDir, name), 0o755);
      }
    }
    const binaryData = bytes.get(binary);
    if (!binaryData) throw new Error(`missing bytes for binary ${binary}`);
    targets[spec.platform ?? "current"] = {
      file: binary,
      sha256: sha256Hex(binaryData),
      size: binaryData.length,
    };
    const manifest = buildManifest(version, targets);
    const manifestJson = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

    // Signature chain files.
    const signingPub = new TextEncoder().encode(this.keychain.signing.publicKeyPem);
    await fs.writeFile(path.join(releaseDir, SIGNING_PUB_FILE), signingPub);
    await fs.writeFile(
      path.join(releaseDir, SIGNING_PUB_SIG_FILE),
      signData(this.keychain.root, signingPub),
    );
    await fs.writeFile(path.join(releaseDir, MANIFEST_FILE), manifestJson);
    await fs.writeFile(
      path.join(releaseDir, sigFileFor(MANIFEST_FILE)),
      signData(this.keychain.signing, manifestJson),
    );
    for (const name of artifactNames) {
      const data = bytes.get(name);
      if (!data) throw new Error(`missing bytes for ${name}`);
      await fs.writeFile(path.join(releaseDir, sigFileFor(name)), signData(this.keychain.signing, data));
    }

    // Pristine copy for restore().
    const pristineFiles = new Map<string, Uint8Array>();
    for (const name of artifactNames) {
      const data = bytes.get(name);
      if (data) pristineFiles.set(name, data);
    }
    pristineFiles.set(SIGNING_PUB_FILE, signingPub);
    pristineFiles.set(
      SIGNING_PUB_SIG_FILE,
      new Uint8Array(await fs.readFile(path.join(releaseDir, SIGNING_PUB_SIG_FILE))),
    );
    pristineFiles.set(MANIFEST_FILE, manifestJson);
    pristineFiles.set(
      sigFileFor(MANIFEST_FILE),
      new Uint8Array(await fs.readFile(path.join(releaseDir, sigFileFor(MANIFEST_FILE)))),
    );
    for (const name of artifactNames) {
      pristineFiles.set(
        sigFileFor(name),
        new Uint8Array(await fs.readFile(path.join(releaseDir, sigFileFor(name)))),
      );
    }
    this.pristine.set(version, pristineFiles);

    if (spec.makeActive !== false) this.activeVersion = version;
    return { version, files: [...pristineFiles.keys()], manifest };
  }

  /**
   * Flip one byte of a served file. offset is 0-based from the start of
   * the file; the byte is XORed with 0xff (a genuine corruption, never a
   * no-op unless applied twice to the same offset).
   */
  async corruptByte(file: string, offset: number): Promise<void> {
    const target = await this.resolveFile(file);
    const data = await fs.readFile(target);
    if (offset < 0 || offset >= data.length) {
      throw new RangeError(
        `corruptByte: offset ${offset} out of range for ${file} (${data.length} bytes)`,
      );
    }
    const corrupted = Buffer.from(data);
    const current = corrupted[offset];
    if (current === undefined) {
      throw new RangeError(`corruptByte: offset ${offset} out of range for ${file}`);
    }
    corrupted[offset] = current ^ 0xff;
    await fs.writeFile(target, corrupted);
  }

  /**
   * Swap two files' contents (signature-swap attack: each file now carries
   * the other's signature, so a verifier rejects both).
   */
  async swapFiles(fileA: string, fileB: string): Promise<void> {
    const a = await this.resolveFile(fileA);
    const b = await this.resolveFile(fileB);
    const dataA = await fs.readFile(a);
    const dataB = await fs.readFile(b);
    await fs.writeFile(a, dataB);
    await fs.writeFile(b, dataA);
  }

  /**
   * Switch the active release to the strictly-older one (downgrade
   * attack). Returns the version now being served. Throws if no strictly
   * older release is published.
   */
  async switchToOlderVersion(): Promise<string> {
    const activeVersion = this.activeVersion;
    if (!activeVersion) throw new Error("no active release");
    const versions = [...this.pristine.keys()].filter((v) => compareVersions(v, activeVersion) < 0);
    if (versions.length === 0) throw new Error("no older release published");
    versions.sort(compareVersions);
    const older = versions[0]; // oldest published
    if (!older) throw new Error("no older release published");
    this.activeVersion = older;
    return older;
  }

  /** Stop serving a file: the client gets 404 for it from now on. */
  async dropFile(file: string): Promise<void> {
    await fs.unlink(await this.resolveFile(file));
  }

  /** Regenerate the active release from its pristine copy (undo tamper). */
  async restore(): Promise<void> {
    const activeVersion = this.activeVersion;
    if (!activeVersion) throw new Error("no active release");
    const pristine = this.pristine.get(activeVersion);
    if (!pristine) throw new Error(`no pristine copy for ${activeVersion}`);
    const releaseDir = this.releaseDir(activeVersion);
    for (const [file, data] of pristine) {
      await fs.writeFile(path.join(releaseDir, file), data);
    }
  }

  /** Read a served file's current bytes (what a client would download). */
  async readFile(file: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(await this.resolveFile(file)));
  }

  /** Absolute path of a served file; throws if missing or escaping root. */
  async resolveFile(file: string): Promise<string> {
    const activeVersion = this.activeVersion;
    if (!activeVersion) throw new Error("no active release");
    const releaseDir = this.releaseDir(activeVersion);
    const resolved = path.resolve(releaseDir, `.${path.sep}${file}`);
    if (resolved !== releaseDir && !resolved.startsWith(releaseDir + path.sep)) {
      throw new Error(`path escapes release root: ${file}`);
    }
    await fs.access(resolved);
    return resolved;
  }

  private releaseDir(version: string): string {
    return path.join(this.storeDir, "releases", version);
  }
}
