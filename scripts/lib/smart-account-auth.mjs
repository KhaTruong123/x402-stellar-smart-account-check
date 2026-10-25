// Builds the `__check_auth` signature for the OpenZeppelin `stellar-accounts`
// 0.8.0 smart account (the OpenZeppelin multisig example account, tag v0.8.0).
//
// The account does not verify the host's signature payload directly. Each
// External signer signs sha256(xdr(AuthDigestPreimage)), where
//   AuthDigestPreimage { account, context_rule_ids, signature_payload }
// and the signature value passed to `__check_auth` is
//   AuthPayload { context_rule_ids, signers: Map<Signer, Bytes> }
// with Signer::External(verifier, public_key). Struct fields are encoded as an
// ScMap with symbol keys in sorted order.

const sym = (sdk, s) => sdk.xdr.ScVal.scvSymbol(s);
const entry = (sdk, key, val) => new sdk.xdr.ScMapEntry({ key, val });

export function externalSigner(sdk, verifierId, rawPublicKey) {
  return sdk.xdr.ScVal.scvVec([
    sym(sdk, "External"),
    new sdk.Address(verifierId).toScVal(),
    sdk.xdr.ScVal.scvBytes(Buffer.from(rawPublicKey)),
  ]);
}

export function buildAuthPayload(sdk, { accountId, verifierId, signerKp, contextRuleId, payload }) {
  const ruleIds = sdk.xdr.ScVal.scvVec([sdk.xdr.ScVal.scvU32(contextRuleId)]);
  const preimage = sdk.xdr.ScVal.scvMap([
    entry(sdk, sym(sdk, "account"), new sdk.Address(accountId).toScVal()),
    entry(sdk, sym(sdk, "context_rule_ids"), ruleIds),
    entry(sdk, sym(sdk, "signature_payload"), sdk.xdr.ScVal.scvBytes(Buffer.from(payload))),
  ]);
  const digest = sdk.hash(preimage.toXDR());
  const signature = signerKp.sign(digest);

  return sdk.xdr.ScVal.scvMap([
    entry(sdk, sym(sdk, "context_rule_ids"), ruleIds),
    entry(
      sdk,
      sym(sdk, "signers"),
      sdk.xdr.ScVal.scvMap([
        entry(
          sdk,
          externalSigner(sdk, verifierId, signerKp.rawPublicKey()),
          sdk.xdr.ScVal.scvBytes(signature),
        ),
      ]),
    ),
  ]);
}

// An x402 `ClientStellarSigner` for the smart account.
//
// `signAuthEntry` is what a wallet would expose today: it signs the auth entry
// preimage with the agent's ed25519 key. On x402 `main` the client only uses
// this path, and the SDK then treats the C... address as an ed25519 key.
//
// `authorizeEntry` is the hook added by x402 PR 3860. It returns the full
// `AuthPayload` through the SDK's `{ signatureScVal }` escape hatch.
export function smartAccountSigner(sdk, { accountId, verifierId, signerKp, contextRuleId }) {
  return {
    address: accountId,
    signAuthEntry: async preimageXdr => {
      const digest = sdk.hash(Buffer.from(preimageXdr, "base64"));
      return {
        signedAuthEntry: signerKp.sign(digest).toString("base64"),
        signerAddress: accountId,
      };
    },
    authorizeEntry: (authEntry, _sign, validUntilLedgerSeq, networkPassphrase) =>
      sdk.authorizeEntry(
        authEntry,
        async (_preimage, payload) => ({
          signatureScVal: buildAuthPayload(sdk, {
            accountId,
            verifierId,
            signerKp,
            contextRuleId,
            payload,
          }),
        }),
        validUntilLedgerSeq,
        networkPassphrase,
      ),
  };
}
