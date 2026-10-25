# Review comment for x402-foundation/x402#3399

Draft for Kelvin to paste on https://github.com/x402-foundation/x402/pull/3399.
Not posted. Links point at `main` of this repo, so merge this repo's PR first.
Verdict: works with concerns.

---

I tested this PR on Stellar testnet with a real smart account. Setup: OpenZeppelin `stellar-accounts` v0.8.0 example account, ed25519 verifier and `spending_limit` policy. The agent key signs only under a rule scoped to the XLM SAC with a 10 XLM limit per 17,280 ledgers. Scripts and raw output: https://github.com/KhaTruong123/x402-stellar-smart-account-check

| Case | Build | Result |
| --- | --- | --- |
| Valid capped payment, 1 XLM | `main` 4241d56 | Refused: `invalid_exact_stellar_payload_event_not_transfer` |
| Same payload | this PR, b88f389 | Verified and settled: [dc36081b](https://stellar.expert/explorer/testnet/tx/dc36081ba559c39fb69fe3332890056aa1f43fe007b5355883b6259d24d30562) |
| Classic G payer, 1 XLM | this PR | Settled: [5f72f54f](https://stellar.expert/explorer/testnet/tx/5f72f54f396eb91f7ec8ceeebbb959b9be7962c81c55b6f4be4e0bb27722845a) |
| Over the limit: 9 XLM after 2 XLM spent | this PR | Refused: `invalid_exact_stellar_payload_simulation_failed`, simulation error `Error(Contract, #3221)` |
| Same over-limit payload sent straight to the network | n/a | Included and failed with 3221: [d3738b45](https://stellar.expert/explorer/testnet/tx/d3738b45e5345d29903be0993182c88b365ef9778b3bb782d2df47dff9abb000) |
| Official client and facilitator end to end | `main` + this PR + #3860 | Settled: [043e4665](https://stellar.expert/explorer/testnet/tx/043e4665ce0fa4613f21d06ea2b864624fa103c45e2394f6bb207de538d94f5e) |

The events match #3352. The policy emits `spending_limit_enforced` with 2 topics, then the SAC emits `transfer` with 4 topics (CAP-67 shape). On `main` the refusal comes from the `topics.length < 3` branch, because the policy event is first and has 2 topics.

Unit tests: 194 pass at the PR head. With this PR and #3860 merged onto current `main` there are no conflicts and 206 pass.

**Does the scan still require exactly one matching transfer?** Yes. I called `validateSimulationEvents` directly with crafted events ([probe](https://github.com/KhaTruong123/x402-stellar-smart-account-check/blob/main/docs/evidence/event-scan-probe-output.txt)). With this PR:

- A `transfer` event from any contract other than `requirements.asset` is ignored. If that is the only transfer, the payload is refused with `no_transfer_events`. A foreign contract cannot fake the payment.
- A second transfer from the asset is refused with `multiple_transfers`. A transfer to the wrong payee is refused with `event_wrong_to`.
- `mint`, `burn` and `clawback` from the asset are refused. A contract event with no emitter is refused.
- Before the scan, verify already pins the call to `asset.transfer(from, payTo, amount)`. The scan is a second check on a call whose arguments are fixed.

**Two points for maintainers:**

1. The PR relaxes more than the description says. On `main`, any non-transfer event from the payment asset is refused. With this PR only `mint`, `burn` and `clawback` are refused. Other asset events now pass, for example `approve` (the payer grants an allowance in the same transaction) and `set_authorized`. I found no harm to the facilitator or the payee: `approve` only touches the payer's own allowance, and `set_authorized` needs the asset admin. But #3352 only needs foreign emitters to be skipped. An allowlist for the asset (`transfer` only, refuse everything else) keeps `main`'s behavior for the asset and still fixes the issue. Either way, a test for `approve` from the asset would pin the chosen behavior.

2. On the spec question in the description (other balance changes): a foreign event can only move balances whose owner authorized it. Verify refuses source-account credentials and any auth entry for a facilitator address, and a G account cannot be a contract invoker. So a payer's `__check_auth` cannot move facilitator funds. It can move the payer's own funds in other tokens, which the payer controls anyway. This is my reading of the Soroban auth model. I did not test it with a hostile contract. The facilitator's real exposure is the fee, bounded by `maxTransactionFeeStroops`.

**Related, outside this PR:** the default fee ceiling still blocks this payer. On testnet the first capped payment was charged 90,173,155 stroops and the second 7,881,487. A classic payer was charged 15,458. With the default `maxTransactionFeeStroops` of 50,000, verify returns `fee_exceeds_maximum` even with this PR (9,066,813 simulated). My guess is that most of the cost is rent on the policy's history entry, which grows on each payment and gets a 30-day TTL extension. I did not break the fee down further. Operators who raise the ceiling for smart accounts also raise what a hostile payer can make them spend per settlement, so it may be worth a note in the docs.

Minor: events from rolled-back calls (`inSuccessfulContractCall: false`) are still counted, on `main` and here. That can only cause a false refusal, not a false accept.

I used an AI coding assistant to write the test scripts and a first draft of this comment. I ran the scripts, checked the transactions on stellar.expert and edited the text.
