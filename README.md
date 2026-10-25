# x402-stellar-smart-account-check

This repo tests two open x402 pull requests on Stellar testnet. Both aim to let a
Soroban smart account (a `C...` contract account) pay through x402 `exact` on Stellar:

| PR | Fixes | What it changes |
| --- | --- | --- |
| [x402-foundation/x402#3860](https://github.com/x402-foundation/x402/pull/3860) | [#3158](https://github.com/x402-foundation/x402/issues/3158) | Client: forwards an optional `authorizeEntry`, so a contract account can sign its own auth entry |
| [x402-foundation/x402#3399](https://github.com/x402-foundation/x402/pull/3399) | [#3352](https://github.com/x402-foundation/x402/issues/3352) | Facilitator: skips contract events that do not come from the payment asset |

The test payer is a smart account with an on-chain spending limit, the setup an
AI agent wallet would use. Funds sit in the account. The agent key can only sign
under a rule that covers the XLM token contract and runs the OpenZeppelin
`spending_limit` policy (10 XLM per 17,280 ledgers, about one day).

## Results

| Check | `main` | With the PR(s) |
| --- | --- | --- |
| Client builds a payment from the smart account | Throws `invalid version byte` | Works with #3860 |
| Facilitator accepts that payment | Refuses: `event_not_transfer` | Settles with #3399: [dc36081b](https://stellar.expert/explorer/testnet/tx/dc36081ba559c39fb69fe3332890056aa1f43fe007b5355883b6259d24d30562) |
| Official client and facilitator end to end | Fails | Settles with both PRs: [043e4665](https://stellar.expert/explorer/testnet/tx/043e4665ce0fa4613f21d06ea2b864624fa103c45e2394f6bb207de538d94f5e) |
| Over-limit payment (9 XLM after 2 XLM spent) | n/a | Refused by client, facilitator and network: [d3738b45](https://stellar.expert/explorer/testnet/tx/d3738b45e5345d29903be0993182c88b365ef9778b3bb782d2df47dff9abb000) |
| Classic `G...` payer | Works | Still works on both PRs |
| x402's own `@x402/stellar` tests | 185 unit, 11 testnet | All pass on each PR and on both merged (206 unit, 11 testnet) |

Verdicts:

- **#3860: works.** Classic signers keep the SDK default path.
- **#3399: works with concerns.** It still requires exactly one transfer from the
  payment asset with the right from, to and amount. But it also starts accepting
  `approve` and `set_authorized` events from the payment asset, which `main`
  refused and the PR description does not mention.

Found along the way: the default facilitator fee ceiling (50,000 stroops) refuses
this payer even with both PRs. On testnet the first capped payment was charged
90,173,155 stroops and the second 7,881,487, against 15,458 for a classic payer.

Details: [docs/evidence/README.md](docs/evidence/README.md).
Review comments ready to paste: [docs/review-3399.md](docs/review-3399.md), [docs/review-3860.md](docs/review-3860.md).

## Layout

| Path | Purpose |
| --- | --- |
| `scripts/build-contracts.sh` | Clones OpenZeppelin `stellar-contracts` v0.8.0 and builds the example account, ed25519 verifier and spending-limit policy |
| `scripts/setup-testnet.mjs` | Creates and funds keys, deploys the contracts, adds the capped agent rule, funds the account |
| `scripts/run-checks.mjs` | Runs the check matrix against four x402 builds |
| `scripts/probe-event-scan.mjs` | Feeds crafted events to the facilitator event check, no network |
| `scripts/collect-fees.mjs` | Reads the fees charged for the settled transactions from Horizon |
| `scripts/lib/smart-account-auth.mjs` | Builds the `__check_auth` signature for the OZ account, and the x402 signer |
| `docs/evidence/` | Outputs, transaction hashes, test logs |

## Rerun it

Needs Node 22+, pnpm 11, Rust with the `wasm32v1-none` target, and the Stellar CLI.

1. Build four x402 checkouts outside this repo:

   ```bash
   git clone https://github.com/x402-foundation/x402.git ~/x402-check/x402
   ```

   ```bash
   cd ~/x402-check/x402 && git fetch origin pull/3399/head:pr-3399 pull/3860/head:pr-3860 && git worktree add ../wt-3399 pr-3399 && git worktree add ../wt-3860 pr-3860 && git worktree add -b both ../wt-both main && git -C ../wt-both merge --no-edit pr-3399 pr-3860
   ```

   In each of `x402`, `wt-3399`, `wt-3860` and `wt-both`, run this from the `typescript` folder:

   ```bash
   pnpm install --frozen-lockfile && pnpm --filter @x402/stellar... build
   ```

2. Install, build the contracts, and deploy to testnet:

   ```bash
   npm install && ./scripts/build-contracts.sh && node scripts/setup-testnet.mjs
   ```

   Friendbot funds the accounts. Secret keys go to `.state/testnet.json`, which git ignores.

3. Run the checks:

   ```bash
   X402_MAIN=~/x402-check/x402 X402_3399=~/x402-check/wt-3399 X402_3860=~/x402-check/wt-3860 X402_BOTH=~/x402-check/wt-both node scripts/run-checks.mjs
   ```

   ```bash
   X402_MAIN=~/x402-check/x402 X402_3399=~/x402-check/wt-3399 X402_BOTH=~/x402-check/wt-both node scripts/probe-event-scan.mjs
   ```

   ```bash
   node scripts/collect-fees.mjs
   ```

The check run spends 2 XLM of the 10 XLM limit, so run `setup-testnet.mjs` again
before a second run inside the same day.

## Notes

- Uploading a new smart-account wasm to testnet costs more than one transaction
  can pay (about 6.5 billion stroops for 46 KB). The setup therefore reuses the
  OpenZeppelin example account, already on testnet, and adds the capped rule
  with an owner-signed `add_context_rule` call.
- The facilitator fee ceiling in `run-checks.mjs` is 300,000,000 stroops so that
  the event scan is what gets tested. Check F5 records the default ceiling.
- Nothing here has been posted to the x402 repo.

## License

MIT. The OpenZeppelin contracts are MIT and are cloned at build time, not copied here.
