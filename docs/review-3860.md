# Review comment for x402-foundation/x402#3860

Draft for Kelvin to paste on https://github.com/x402-foundation/x402/pull/3860.
Not posted. Links point at `main` of this repo, so merge this repo's PR first.
Verdict: works.

---

I tested this PR on Stellar testnet with a real smart account. Setup: OpenZeppelin `stellar-accounts` v0.8.0 example account, ed25519 verifier and `spending_limit` policy. The agent key signs only under a rule scoped to the XLM SAC with a 10 XLM limit per 17,280 ledgers. Scripts and raw output: https://github.com/KhaTruong123/x402-stellar-smart-account-check

| Case | Build | Result |
| --- | --- | --- |
| Smart-account payer, client `createPaymentPayload` | `main` 4241d56 | Throws `invalid version byte. expected 48, got 16` (same as #3158) |
| Same signer with `authorizeEntry` | this PR, 30c91d1 | Payload created. The client's second simulation runs `__check_auth` and passes |
| Classic G payer via `createEd25519Signer`, no override | this PR | Payload created and settled by the `main` facilitator: [f85b4b84](https://stellar.expert/explorer/testnet/tx/f85b4b842ee7238fbe559b003cb0c945f7fd973c1ef2063342f85642b8cb8c2a) |
| Over the limit: 9 XLM after 2 XLM spent | `main` + this PR + #3399 | Client throws before any facilitator call, simulation shows `Error(Contract, #3221)` |
| Official client and facilitator end to end | `main` + this PR + #3399 | Settled: [043e4665](https://stellar.expert/explorer/testnet/tx/043e4665ce0fa4613f21d06ea2b864624fa103c45e2394f6bb207de538d94f5e) |

Unit tests: 180 pass at the PR head. With this PR and #3399 merged onto current `main` there are no conflicts and 206 pass.

**Ed25519 accounts:** unchanged. The spread only adds the key when the signer has `authorizeEntry`. That matters, because `signAuthEntries` runs its signer checks only when `authorizeEntry` is the SDK default. The G payment above went through the default path on this branch.

**Notes:**

1. This PR alone does not let an OZ policy account pay a `main` facilitator. The `main` facilitator refuses the payment created here with `invalid_exact_stellar_payload_event_not_transfer`, because the policy emits its own event (#3352, fixed by #3399). Accounts whose `__check_auth` emits no contract event do not hit that check, so for them this PR is enough.

2. A short example would help integrators. The override that worked for me ignores the SDK's signer callback and returns the account's own signature:

   ```js
   authorizeEntry: (entry, _sign, validUntil, passphrase) =>
     authorizeEntry(entry, async (_preimage, payload) => ({
       signatureScVal: buildAccountSignature(payload), // AuthPayload for OZ accounts
     }), validUntil, passphrase),
   ```

   For OZ `stellar-accounts` 0.8.0, `buildAccountSignature` must sign `sha256(xdr(AuthDigestPreimage { account, context_rule_ids, signature_payload }))`, not the host payload. That detail is easy to miss.

3. `signAuthEntry` is still required by the type, even when `authorizeEntry` never calls it. A contract-account signer has to pass a stub. Making it optional when `authorizeEntry` is set, or documenting the stub, would make that clearer. `isClientStellarSigner` also does not check that `authorizeEntry` is a function when present.

4. The same fee point as on #3399 applies here: with the default `maxTransactionFeeStroops` of 50,000, a facilitator refuses this payer on testnet (`fee_exceeds_maximum`). The first capped payment was charged 90,173,155 stroops.

I used an AI coding assistant to write the test scripts and a first draft of this comment. I ran the scripts, checked the transactions on stellar.expert and edited the text.
