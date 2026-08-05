/**
 * Signature verification (L0.5) — the chain that makes "verified" mean something.
 *
 * Two tiers, after Tailscale's distsign (re-implemented, not copied):
 *
 *   offline root keys  --sign-->  signing key  --sign-->  each artifact
 *
 * Root public keys are compiled into the application; the signing key is
 * served and may rotate. Both links must hold, so a publisher who loses their
 * signing key does not lose the ability to rotate, and an attacker who
 * compromises the file host cannot mint a signing key the roots never blessed.
 *
 * Why this exists even though artifacts carry a sha256: the digest comes from
 * the same place as the bytes. If the release source is compromised or
 * MITM'd, its digest matches its malicious payload perfectly. A digest proves
 * INTEGRITY (nothing corrupted in transit); a signature proves AUTHENTICITY
 * (these bytes came from someone holding the key). K needs both.
 *
 * Fail-closed by construction: there is no "unsigned is fine" path and no
 * flag that disables verification. If an adopter has no keys, they say so by
 * calling `unverifiedSource()` explicitly, which is visible in their code and
 * reported in status — not by K silently skipping a check.
 */
import { verify as edVerify, createPublicKey } from "node:crypto";

export class SignatureError extends Error {
  readonly code: SignatureErrorCode;

  constructor(code: SignatureErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = "SignatureError";
    this.code = code;
  }
}

export type SignatureErrorCode =
  | "SIGNING_KEY_NOT_ROOT_SIGNED"
  | "ARTIFACT_SIGNATURE_INVALID"
  | "MALFORMED_KEY"
  | "NO_ROOT_KEYS";

/** What a publisher serves alongside the artifact. */
export interface SignatureBundle {
  /** PEM of the current signing key. */
  signingKeyPem: string;
  /** Signature over signingKeyPem, made by one of the offline roots. */
  signingKeySignature: Uint8Array;
  /** Signature over the artifact bytes, made by the signing key. */
  artifactSignature: Uint8Array;
}

function verifyWith(publicKeyPem: string, data: Uint8Array, sig: Uint8Array): boolean {
  try {
    return edVerify(null, data, createPublicKey(publicKeyPem), sig);
  } catch {
    return false; // malformed key or signature is a failure, never a pass
  }
}

/**
 * Verify the full chain. Throws SignatureError on any break; returns the
 * signing key that vouched for the artifact, so callers can record WHICH key
 * was trusted rather than just "it passed".
 */
export function verifyChain(
  artifactBytes: Uint8Array,
  bundle: SignatureBundle,
  rootKeysPem: readonly string[],
): { signingKeyPem: string; rootKeyPem: string } {
  if (rootKeysPem.length === 0) {
    throw new SignatureError(
      "NO_ROOT_KEYS",
      "no root keys were provided; K will not accept an artifact it cannot attribute",
    );
  }

  // Link 1: some offline root must vouch for this signing key. Trying each
  // root is what makes rotation possible — during a rotation window both the
  // outgoing and incoming roots are present in shipped clients.
  const signingBytes = new TextEncoder().encode(bundle.signingKeyPem);
  const rootKeyPem = rootKeysPem.find((root) =>
    verifyWith(root, signingBytes, bundle.signingKeySignature),
  );
  if (rootKeyPem === undefined) {
    throw new SignatureError(
      "SIGNING_KEY_NOT_ROOT_SIGNED",
      `the served signing key is not signed by any of the ${rootKeysPem.length} trusted root key(s)`,
    );
  }

  // Link 2: that signing key must vouch for these exact bytes.
  if (!verifyWith(bundle.signingKeyPem, artifactBytes, bundle.artifactSignature)) {
    throw new SignatureError(
      "ARTIFACT_SIGNATURE_INVALID",
      "the artifact's signature does not match its bytes under the served signing key",
    );
  }

  return { signingKeyPem: bundle.signingKeyPem, rootKeyPem };
}
