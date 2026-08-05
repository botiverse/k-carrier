// @invariant — the two-level chain is the supply-chain model (design L0.5):
// root trusts signing.pub, signing.pub trusts the file; any break must
// reject. Never disable-able (transparency §1.8).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createKeychain,
  createKeyPair,
  signData,
  verifySignature,
  verifyChain,
  verifyWithPublicPem,
  pemFromBytes,
} from "./keychain.ts";

test("sign/verify roundtrip with a fresh keypair", () => {
  const kp = createKeyPair();
  const data = new TextEncoder().encode("release bytes");
  const sig = signData(kp, data);
  assert.equal(verifySignature(kp, data, sig), true);
  assert.equal(verifySignature(kp, new Uint8Array([0]), sig), false);
});

test("verifySignature never throws on garbage input", () => {
  const kp = createKeyPair();
  assert.equal(verifySignature(kp, new Uint8Array([1]), new Uint8Array([2, 3])), false);
});

test("full chain: root-signed signing.pub plus signing-signed file", () => {
  const kc = createKeychain();
  const file = new TextEncoder().encode("app binary");
  const signingPub = new TextEncoder().encode(kc.signing.publicKeyPem);
  const ok = verifyChain({
    root: kc.root,
    signingPub,
    signingPubSig: signData(kc.root, signingPub),
    data: file,
    dataSig: signData(kc.signing, file),
  });
  assert.equal(ok, true);
});

test("chain rejects when signing.pub is not root-signed (forged signing key)", () => {
  const kc = createKeychain();
  const attacker = createKeyPair(); // attacker's own key, no root signature
  const file = new TextEncoder().encode("app binary");
  const signingPub = new TextEncoder().encode(attacker.publicKeyPem);
  const ok = verifyChain({
    root: kc.root,
    signingPub,
    signingPubSig: signData(attacker, signingPub), // self-signed, NOT root
    data: file,
    dataSig: signData(attacker, file),
  });
  assert.equal(ok, false);
});

test("chain rejects when the file is tampered but signature is valid-for-original", () => {
  const kc = createKeychain();
  const original = new TextEncoder().encode("app binary");
  const tampered = new TextEncoder().encode("app binary!");
  const signingPub = new TextEncoder().encode(kc.signing.publicKeyPem);
  const ok = verifyChain({
    root: kc.root,
    signingPub,
    signingPubSig: signData(kc.root, signingPub),
    data: tampered,
    dataSig: signData(kc.signing, original),
  });
  assert.equal(ok, false);
});

test("verifyWithPublicPem accepts the served signing.pub form", () => {
  const kc = createKeychain();
  const file = new TextEncoder().encode("data");
  const sig = signData(kc.signing, file);
  assert.equal(verifyWithPublicPem(kc.signing.publicKeyPem, file, sig), true);
  assert.equal(verifyWithPublicPem(pemFromBytes(new TextEncoder().encode(kc.signing.publicKeyPem)), file, sig), true);
});
