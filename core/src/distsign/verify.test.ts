// @invariant — authenticity, not merely integrity: a matching digest from a
// compromised source must NOT be enough to install.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { verifyChain, SignatureError, type SignatureBundle } from "./verify.ts";

function keypair(): { pub: string; priv: import("node:crypto").KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pub: publicKey.export({ type: "spki", format: "pem" }) as string, priv: privateKey };
}

const BYTES = new TextEncoder().encode("the real artifact");

function bundleFrom(
  root: ReturnType<typeof keypair>,
  signing: ReturnType<typeof keypair>,
  artifactBytes: Uint8Array = BYTES,
): SignatureBundle {
  return {
    signingKeyPem: signing.pub,
    signingKeySignature: edSign(null, new TextEncoder().encode(signing.pub), root.priv),
    artifactSignature: edSign(null, artifactBytes, signing.priv),
  };
}

test("a properly signed artifact verifies and reports which keys vouched", () => {
  const root = keypair();
  const signing = keypair();
  const result = verifyChain(BYTES, bundleFrom(root, signing), [root.pub]);
  assert.equal(result.signingKeyPem, signing.pub);
  assert.equal(result.rootKeyPem, root.pub);
});

test("THE POINT: a perfectly-matching digest from an untrusted signer is refused", () => {
  // Models a compromised release source: it serves malicious bytes together
  // with a correct sha256 AND a valid signature — just not one any trusted
  // root ever blessed. Integrity checks pass; authenticity must not.
  const attacker = keypair();
  const trustedRoot = keypair();
  const evil = new TextEncoder().encode("malicious payload");
  const selfConsistent = bundleFrom(attacker, attacker, evil);
  assert.throws(
    () => verifyChain(evil, selfConsistent, [trustedRoot.pub]),
    (err: unknown) =>
      err instanceof SignatureError && err.code === "SIGNING_KEY_NOT_ROOT_SIGNED",
  );
});

test("tampered bytes fail even when the signing key is legitimate", () => {
  const root = keypair();
  const signing = keypair();
  const bundle = bundleFrom(root, signing);
  const tampered = new TextEncoder().encode("the real artifactX");
  assert.throws(
    () => verifyChain(tampered, bundle, [root.pub]),
    (err: unknown) => err instanceof SignatureError && err.code === "ARTIFACT_SIGNATURE_INVALID",
  );
});

test("rotation works because every shipped root is tried, not just the newest", () => {
  const outgoing = keypair();
  const incoming = keypair();
  const signing = keypair();
  // signed by the INCOMING root while clients still carry both
  const bundle = bundleFrom(incoming, signing);
  const result = verifyChain(BYTES, bundle, [outgoing.pub, incoming.pub]);
  assert.equal(result.rootKeyPem, incoming.pub);
});

test("no root keys is a refusal, not a free pass", () => {
  const root = keypair();
  const signing = keypair();
  assert.throws(
    () => verifyChain(BYTES, bundleFrom(root, signing), []),
    (err: unknown) => err instanceof SignatureError && err.code === "NO_ROOT_KEYS",
  );
});

test("a malformed key or signature fails closed rather than throwing something untyped", () => {
  const root = keypair();
  const signing = keypair();
  const bundle = { ...bundleFrom(root, signing), signingKeyPem: "not a pem at all" };
  assert.throws(
    () => verifyChain(BYTES, bundle, [root.pub]),
    (err: unknown) => err instanceof SignatureError,
  );
});
