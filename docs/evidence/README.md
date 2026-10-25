# Evidence

All runs on Stellar testnet (protocol 29), 2026-10-25. Keys were generated at
run time and are not in this repo.

## Builds tested

| Label | Commit | What it is |
| --- | --- | --- |
| `main` | `4241d56c` | x402 `main` on 2026-10-25 |
| `pr-3399` | `b88f3893` | Head of x402-foundation/x402#3399 (facilitator event scan) |
| `pr-3860` | `30c91d11` | Head of x402-foundation/x402#3860 (client `authorizeEntry`) |
| `main+3399+3860` | `2b62413c` | `main` with both PRs merged locally, no conflicts |

## x402's own tests (`@x402/stellar`)

| Build | Unit tests | Testnet integration tests |
| --- | --- | --- |
| `main` | 185 passed ([log](unit-tests/main-4241d56.txt)) | 11 passed ([log](integration-tests/main-4241d56.txt)) |
| `pr-3399` | 194 passed ([log](unit-tests/pr-3399-b88f389.txt)) | 11 passed ([log](integration-tests/pr-3399-b88f389.txt)) |
| `pr-3860` | 180 passed ([log](unit-tests/pr-3860-30c91d1.txt)) | 11 passed ([log](integration-tests/pr-3860-30c91d1.txt)) |
| `main+3399+3860` | 206 passed ([log](unit-tests/main+3399+3860-2b62413.txt)) | 11 passed ([log](integration-tests/main+3399+3860-2b62413.txt)) |

The PR heads sit on older bases than `main`, which is why their unit counts differ.

## Testnet setup ([setup.json](setup.json))

| Step | Transaction |
| --- | --- |
| Deploy OZ ed25519 verifier | [db01afca](https://stellar.expert/explorer/testnet/tx/db01afca3614af4594733a27e95df9136cddeb0facab1fadcf1d00899d36e13d) |
| Deploy OZ spending-limit policy | [fdb3df0f](https://stellar.expert/explorer/testnet/tx/fdb3df0ff99cd2af05fb7213907da197618080b8f873d459005c6cada1ee1ddd) |
| Deploy OZ smart account, rule 0 = owner key | [ac2d55b2](https://stellar.expert/explorer/testnet/tx/ac2d55b2748444749ba1c9dc723e621cf176b875e28c3d7ea740b890730af499) |
| Owner adds rule 1: agent key, XLM SAC only, 10 XLM per 17,280 ledgers | [f4bf1a22](https://stellar.expert/explorer/testnet/tx/f4bf1a226333709633e7022047f143a9ced59abaed9d706d8922e781ebb6fc50) |
| Fund the smart account with 50 XLM | [ccc27616](https://stellar.expert/explorer/testnet/tx/ccc27616d37fb8af6bf5bf9385246221c0ab47c5b4ddc27db6aaa4b8ce69d331) |

Smart account: [CAEIDYUI...DL2EG](https://stellar.expert/explorer/testnet/contract/CAEIDYUIZZHKI7JVFHOXA2OVQDJ64UG3EZPKYMHDAQNVUGKODMTDL2EG).
Policy: [CCVIHJ2R...URFA](https://stellar.expert/explorer/testnet/contract/CCVIHJ2RNUSSC7X2D6GEQTITJL3WPU4IJSB6FMAPJETGW3MJIQZKURFA).
Contracts are the OpenZeppelin `stellar-contracts` v0.8.0 examples, unmodified. Wasm hashes are in `setup.json`.

## Check matrix ([checks.json](checks.json), [full output](run-checks-output.txt))

Payments are 1 XLM to the same payee. The facilitator fee ceiling is raised to
300,000,000 stroops for every case except F5 (see the fee section).

| Id | Case | Result | Transaction |
| --- | --- | --- | --- |
| C1 | `main` client, smart-account payer | Throws `invalid version byte. expected 48, got 16` | none |
| C2 | `pr-3860` client, smart-account payer | Payload created; client re-simulation with real auth passes | none |
| F1 | `main` facilitator verifies the C2 payload | `invalid_exact_stellar_payload_event_not_transfer` | none |
| F2 | `pr-3399` facilitator settles the C2 payload | Verified and settled | [dc36081b](https://stellar.expert/explorer/testnet/tx/dc36081ba559c39fb69fe3332890056aa1f43fe007b5355883b6259d24d30562) |
| C3 | `pr-3860` client, classic G payer, `main` facilitator | Settled | [f85b4b84](https://stellar.expert/explorer/testnet/tx/f85b4b842ee7238fbe559b003cb0c945f7fd973c1ef2063342f85642b8cb8c2a) |
| F3 | `main` client, classic G payer, `pr-3399` facilitator | Settled | [5f72f54f](https://stellar.expert/explorer/testnet/tx/5f72f54f396eb91f7ec8ceeebbb959b9be7962c81c55b6f4be4e0bb27722845a) |
| E1 | `main+3399+3860` client and facilitator, smart-account payer | Settled | [043e4665](https://stellar.expert/explorer/testnet/tx/043e4665ce0fa4613f21d06ea2b864624fa103c45e2394f6bb207de538d94f5e) |
| F5 | `main+3399+3860` facilitator with the default 50,000 stroop ceiling | `invalid_exact_stellar_payload_fee_exceeds_maximum` (9,066,813 simulated) | none |
| L1 | Client, 9 XLM after 2 XLM spent (limit 10) | Client throws, `Error(Contract, #3221)` SpendingLimitExceeded | none |
| L2 | Same payload signed without the client check, `pr-3399` and merged facilitators | `invalid_exact_stellar_payload_simulation_failed`, `Error(Contract, #3221)` | none |
| L3 | Same payload sent straight to the network | Included, FAILED, `invokeHostFunctionTrapped`, contract error 3221 | [d3738b45](https://stellar.expert/explorer/testnet/tx/d3738b45e5345d29903be0993182c88b365ef9778b3bb782d2df47dff9abb000) |

After the run the policy reports 20,000,000 stroops (2 XLM) spent of 100,000,000,
and the account balance went from 50 XLM to 48 XLM. Only F2 and E1 moved funds.

Event order in F2 and E1, read back from the ledger: `spending_limit_enforced`
from the policy (2 topics), then `transfer` from the XLM SAC (4 topics).

## Fees actually charged ([fees.json](fees.json))

| Check | Payer | Fee charged (stroops) |
| --- | --- | --- |
| F2 | smart account, first capped payment | 90,173,155 |
| E1 | smart account, second capped payment | 7,881,487 |
| C3, F3 | classic G | 15,458 |
| L3 | failed over-limit attempt | 14,280 |

The default facilitator ceiling is 50,000 stroops, so a default facilitator
refuses this payer even with both PRs. The cost seems to come mostly from rent
on the policy's persistent history entry, which grows on each payment and gets
a 30-day TTL extension. That part is an inference, not a measured breakdown.

## Event-scan probe ([output](event-scan-probe-output.txt), [json](event-scan-probe.json))

Crafted events passed straight to the facilitator's `validateSimulationEvents`.
No network. Shows which shapes each build accepts.

| Id | Events (all with a valid 1 XLM asset transfer unless noted) | `main` | `pr-3399` |
| --- | --- | --- | --- |
| P1 | OZ policy event first | refused | accepted |
| P3 | Only a fake `transfer` from a foreign contract | refused | refused |
| P4 | Plus a transfer of another token | refused | accepted |
| P5 | Plus a second asset transfer to another address | refused | refused |
| P6 | Plus asset `approve` | refused | accepted |
| P7 | Plus asset `set_authorized` | refused | accepted |
| P8, P9 | Plus asset `burn` or `mint` | refused | refused |
| P10 | Plus a rolled-back asset transfer | refused | refused |
| P11 | Foreign event with no topics first | refused | accepted |
| P12 | Contract event with no emitter | refused | refused |
| P13 | Only an asset transfer to the wrong payee | refused | refused |

The merged build gives the same results as `pr-3399`.

## Blocker met and how it was handled

A simulated upload of new smart-account code asked 7,798,187,370 stroops
(about 780 XLM) in resource fees ([wasm-upload-simulation.json](wasm-upload-simulation.json)).
The wasm is the OZ example account with a random custom section appended, so
the code is the same but the hash is new (47,576 bytes). The same wasm without
the extra section is already on testnet and asks 132,210 stroops.

7.8 billion is above the uint32 fee field of a plain transaction
(4,294,967,295), so the Stellar SDK refuses to build it. A fee-bump transaction
carries an int64 fee and may get around that limit. I did not try it, because
reusing the deployed example was cheaper and needs no new code. So this check
does not upload a custom account. It reuses the OpenZeppelin v0.8.0 example
account and adds the capped rule with an owner-signed `add_context_rule` call.
