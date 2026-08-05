/**
 * Test signature chain — Ed25519, Node `crypto` only (harness-design §1.2;
 * archer: "签名链的测试密钥生成也在你这件里（Ed25519，Node crypto 就够，别引依赖）").
 *
 * Two-level distsign model (design-v1 §L0.5): an offline root key signs the
 * (rotatable) signing key; the signing key signs every released file. The
 * client compiles root public keys in; the server serves signing.pub +
 * signing.pub.sig + per-file .sig. Verification is NEVER disable-able —
 * these are just another set of real keys (transparency §1.8).
 *
 * This is the harness's own chain (core distsign lands later and mirrors
 * the same shape); the harness teeth prove "real tamper -> real reject"
 * through it.
 */
import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export interface TestKeyPair {
  /** SPKI PEM — the served/trusted public key form. */
  publicKeyPem: string;
  /** PKCS8 PEM — harness-side only, never served. */
  privateKeyPem: string;
}

export interface TestKeychain {
  /** Offline root: the client-side trust anchor (not served). */
  root: TestKeyPair;
  /** Rotatable signing key: signing.pub + signing.pub.sig are served. */
  signing: TestKeyPair;
}

function toKeyObject(pem: string, kind: "public" | "private"): KeyObject {
  return kind === "public" ? createPublicKey(pem) : createPrivateKey(pem);
}

export function createKeyPair(): TestKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
}

export function createKeychain(): TestKeychain {
  return { root: createKeyPair(), signing: createKeyPair() };
}

/** Detached Ed25519 signature over data. */
export function signData(key: TestKeyPair, data: Uint8Array): Uint8Array {
  return sign(null, data, toKeyObject(key.privateKeyPem, "private"));
}

/** Verify a detached signature. Never throws; false = not authentic. */
export function verifySignature(key: TestKeyPair, data: Uint8Array, sig: Uint8Array): boolean {
  try {
    return verify(null, data, toKeyObject(key.publicKeyPem, "public"), sig);
  } catch {
    return false;
  }
}

export interface ChainVerifyInput {
  root: TestKeyPair;
  /** Bytes of the served signing.pub file. */
  signingPub: Uint8Array;
  /** Root's signature over signingPub. */
  signingPubSig: Uint8Array;
  /** The file content being verified. */
  data: Uint8Array;
  /** Signing key's signature over data. */
  dataSig: Uint8Array;
}

/**
 * Full two-level chain check: root trusts signing.pub, signing.pub trusts
 * the file. Both links must hold — a forged signing.pub (not root-signed)
 * and a forged/tampered file both fail here.
 */
export function verifyChain(input: ChainVerifyInput): boolean {
  const rootTrustsSigning = verifySignature(input.root, input.signingPub, input.signingPubSig);
  if (!rootTrustsSigning) return false;
  return verifyWithPublicPem(
    pemFromBytes(input.signingPub),
    input.data,
    input.dataSig,
  );
}

/** Verify with a raw SPKI PEM public key (e.g. the served signing.pub). */
export function verifyWithPublicPem(publicKeyPem: string, data: Uint8Array, sig: Uint8Array): boolean {
  try {
    return verify(null, data, toKeyObject(publicKeyPem, "public"), sig);
  } catch {
    return false;
  }
}

/** signing.pub is served as raw PEM bytes; parse it back for verification. */
export function pemFromBytes(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
