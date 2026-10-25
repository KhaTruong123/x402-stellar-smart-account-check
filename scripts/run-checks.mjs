// Runs the x402 exact/stellar check matrix on testnet against four builds:
//   main   x402 main
//   3399   PR 3399 head (facilitator event scan)
//   3860   PR 3860 head (client authorizeEntry hook)
//   both   main + 3399 + 3860 merged locally
//
// Usage:
//   X402_MAIN=... X402_3399=... X402_3860=... X402_BOTH=... node scripts/run-checks.mjs
// Each variable points at the root of a built x402 checkout.
// Needs .state/testnet.json from scripts/setup-testnet.mjs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { simulationContractEvents, transactionContractEvents } from "./lib/events.mjs";
import { signedTransferWithoutClientCheck, submitOverCapOnChain } from "./lib/over-cap.mjs";
import { smartAccountSigner } from "./lib/smart-account-auth.mjs";
import { NETWORK, RPC_URL, nativeBalance, txLink, waitForTx } from "./lib/testnet.mjs";
import { loadX402 } from "./lib/x402-checkout.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const state = JSON.parse(readFileSync(join(ROOT, ".state/testnet.json"), "utf8"));
const XLM = 10_000_000n;
// A smart-account payment runs __check_auth, the verifier and the policy, and
// grows the policy's persistent history entry. On testnet in October 2026 the
// simulation asks about 103.7M stroops (10.4 XLM) for that, against about
// 21,000 for a classic payer. The ceiling is raised so the event scan is what
// gets tested; case F5 records what the default (50,000) does.
const FEE_CEILING_STROOPS = 300_000_000;

const builds = {
  main: loadX402("main", process.env.X402_MAIN),
  3399: loadX402("pr-3399", process.env.X402_3399),
  3860: loadX402("pr-3860", process.env.X402_3860),
  both: loadX402("main+3399+3860", process.env.X402_BOTH),
};
const sdk = builds.both.sdk;
const server = new sdk.rpc.Server(RPC_URL);
const kp = name => builds.both.sdk.Keypair.fromSecret(state.secrets[name]);
const { accountId, verifierId, policyId, tokenId } = state.contracts;
const payee = kp("payee").publicKey();
const results = [];

const requirements = amountStroops => ({
  scheme: "exact",
  network: NETWORK,
  amount: amountStroops.toString(),
  asset: tokenId,
  payTo: payee,
  maxTimeoutSeconds: 120,
  extra: { areFeesSponsored: true },
});
const toPayload = (accepted, transaction) => ({
  x402Version: 2,
  accepted,
  payload: { transaction },
  resource: { url: "https://example.test/paid", description: "check", mimeType: "text/plain" },
});

function smartSigner(build) {
  return smartAccountSigner(build.sdk, {
    accountId,
    verifierId,
    signerKp: build.sdk.Keypair.fromSecret(state.secrets.agent),
    contextRuleId: state.agentContextRuleId,
  });
}
function facilitator(build, options = { maxTransactionFeeStroops: FEE_CEILING_STROOPS }) {
  const signer = build.createEd25519Signer(state.secrets.facilitator, NETWORK);
  return new build.Facilitator([signer], { rpcConfig: { url: RPC_URL }, ...options });
}
async function createPayload(build, signer, amount) {
  const accepted = requirements(amount);
  const client = new build.Client(signer, { url: RPC_URL });
  const created = await client.createPaymentPayload(2, accepted);
  return toPayload(accepted, created.payload.transaction);
}
async function simulatedEvents(txXdr) {
  const sim = await server.simulateTransaction(new sdk.Transaction(txXdr, sdk.Networks.TESTNET));
  return {
    minResourceFee: sim.minResourceFee,
    error: sim.error,
    contractEvents: simulationContractEvents(sdk, sim.events),
  };
}
async function settledEvents(hash) {
  return transactionContractEvents(sdk, await waitForTx(server, hash));
}

async function readSpending() {
  const sim = await server.simulateTransaction(
    new sdk.TransactionBuilder(new sdk.Account(kp("payee").publicKey(), "0"), {
      fee: "100",
      networkPassphrase: sdk.Networks.TESTNET,
    })
      .addOperation(
        new sdk.Contract(policyId).call(
          "get_spending_limit_data",
          sdk.xdr.ScVal.scvU32(state.agentContextRuleId),
          new sdk.Address(accountId).toScVal(),
        ),
      )
      .setTimeout(30)
      .build(),
  );
  return sdk.scValToNative(sim.result.retval);
}

async function check(id, title, expected, fn, { throws } = {}) {
  process.stdout.write(`\n[${id}] ${title}\n  expected: ${expected}\n`);
  const row = { id, title, expected };
  try {
    Object.assign(row, await fn());
  } catch (error) {
    const message = String(error?.message ?? error);
    row.threw = message.split("\n").slice(0, 3).join(" | ");
    if (throws) {
      row.pass = throws.test(message);
      row.matched = throws.exec(message)?.[0];
    }
  }
  row.pass = row.pass ?? false;
  const { id: _i, title: _t, expected: _e, ...shown } = row;
  process.stdout.write(`  observed: ${JSON.stringify(shown, null, 2).replace(/\n/g, "\n  ")}\n`);
  results.push(row);
  return row;
}

async function main() {
  const startBalance = await nativeBalance(sdk, server, accountId);
  const payloads = {};

  await check("C1", "main client, smart-account payer", "throws in signAuthEntries (ed25519 path on a C address)", async () => {
    await createPayload(builds.main, smartSigner(builds.main), XLM);
    return { pass: false, note: "payload was created; expected a throw" };
  }, { throws: /invalid version byte/ });

  await check("C2", "PR 3860 client, smart-account payer", "payload created; client re-simulation with real auth succeeds", async () => {
    payloads.smart1 = await createPayload(builds[3860], smartSigner(builds[3860]), XLM);
    const sim = await simulatedEvents(payloads.smart1.payload.transaction);
    return { pass: true, simulation: sim };
  });

  await check("F1", "main facilitator verifies the C2 payload", "isValid false, invalid_exact_stellar_payload_event_not_transfer", async () => {
    const verify = await facilitator(builds.main).verify(payloads.smart1, payloads.smart1.accepted);
    return { verify, pass: verify.invalidReason === "invalid_exact_stellar_payload_event_not_transfer" };
  });

  await check("F2", "PR 3399 facilitator settles the same C2 payload", "verify ok, settle success, one policy event plus one transfer on-chain", async () => {
    const f = facilitator(builds[3399]);
    const verify = await f.verify(payloads.smart1, payloads.smart1.accepted);
    const settle = await f.settle(payloads.smart1, payloads.smart1.accepted);
    const events = settle.success ? await settledEvents(settle.transaction) : undefined;
    return { verify, settle, link: settle.success ? txLink(settle.transaction) : undefined, events, pass: verify.isValid && settle.success };
  });

  await check("C3", "PR 3860 client, classic G payer, settled by main facilitator", "unchanged ed25519 path: payload created and settled", async () => {
    const p = await createPayload(builds[3860], builds[3860].createEd25519Signer(state.secrets.classicPayer, NETWORK), XLM);
    const settle = await facilitator(builds.main).settle(p, p.accepted);
    return { settle, link: settle.success ? txLink(settle.transaction) : undefined, pass: settle.success };
  });

  await check("F3", "main client, classic G payer, settled by PR 3399 facilitator", "classic payments still settle under the new event scan", async () => {
    const p = await createPayload(builds.main, builds.main.createEd25519Signer(state.secrets.classicPayer, NETWORK), XLM);
    const settle = await facilitator(builds[3399]).settle(p, p.accepted);
    const events = settle.success ? await settledEvents(settle.transaction) : undefined;
    return { settle, link: settle.success ? txLink(settle.transaction) : undefined, events, pass: settle.success };
  });

  await check("E1", "main+3399+3860, smart-account payer end to end", "official client and facilitator settle a capped smart-account payment", async () => {
    payloads.smart2 = await createPayload(builds.both, smartSigner(builds.both), XLM);
    const settle = await facilitator(builds.both).settle(payloads.smart2, payloads.smart2.accepted);
    const events = settle.success ? await settledEvents(settle.transaction) : undefined;
    return { settle, link: settle.success ? txLink(settle.transaction) : undefined, events, pass: settle.success };
  });

  await check("F5", "main+3399+3860 facilitator with its default fee ceiling", "observation only: does the default 50,000 stroop ceiling admit this payer?", async () => {
    const p = await createPayload(builds.both, smartSigner(builds.both), XLM);
    const verify = await facilitator(builds.both, {}).verify(p, p.accepted);
    const sim = await simulatedEvents(p.payload.transaction);
    return { verify, minResourceFee: sim.minResourceFee, pass: true, note: "not settled; the signed entry expires unused" };
  });

  const spent = BigInt((await readSpending()).cached_total_spent);
  const overAmount = BigInt(state.spendingLimitStroops) - spent + XLM; // total would be limit + 1 XLM
  await check("L1", `client refuses an over-limit payment (${overAmount / XLM} XLM after ${spent / XLM} XLM spent, limit ${BigInt(state.spendingLimitStroops) / XLM} XLM)`, "client throws; simulation shows Error(Contract, #3221) SpendingLimitExceeded", async () => {
    await createPayload(builds.both, smartSigner(builds.both), overAmount);
    return { pass: false, note: "payload was created; expected a throw" };
  }, { throws: /Error\(Contract, #3221\)/ });

  await check("L2", "facilitator refuses the same over-limit payload built without the client check", "PR 3399 and main+3399+3860 facilitators return simulation_failed", async () => {
    const overCapXdr = await signedTransferWithoutClientCheck(builds.both.sdk, { signer: smartSigner(builds.both), requirements: requirements(overAmount), rpcUrl: RPC_URL });
    payloads.overCapXdr = overCapXdr;
    const p = toPayload(requirements(overAmount), overCapXdr);
    const verify3399 = await facilitator(builds[3399]).verify(p, p.accepted);
    const verifyBoth = await facilitator(builds.both).verify(p, p.accepted);
    const sim = await simulatedEvents(overCapXdr);
    const contractError = /Error\(Contract, #\d+\)/.exec(sim.error ?? "")?.[0];
    return {
      verify3399,
      verifyBoth,
      simulationError: contractError,
      pass: verify3399.invalidReason === "invalid_exact_stellar_payload_simulation_failed" && verifyBoth.invalidReason === "invalid_exact_stellar_payload_simulation_failed" && contractError === "Error(Contract, #3221)",
    };
  });

  await check("L3", "network refuses the over-limit payload when submitted directly", "transaction is included and FAILED; the contract call traps", async () => {
    const sent = await submitOverCapOnChain(sdk, { server, sourceKp: kp("facilitator"), overCapXdr: payloads.overCapXdr, withinCapXdr: payloads.smart2.payload.transaction });
    if (sent.status !== "PENDING") return { sendStatus: sent.status, errorResult: sent.errorResult?.result().switch().name, pass: false };
    const r = await waitForTx(server, sent.hash);
    const opResult = r.resultXdr?.result().results()?.[0]?.tr().invokeHostFunctionResult().switch().name;
    const diag = (r.diagnosticEventsXdr ?? []).map(d => d.event().body().v0()).map(b => { try { return JSON.stringify(sdk.scValToNative(b.data())); } catch { return ""; } }).filter(s => s.includes("3221") || s.includes("Contract")).slice(0, 2);
    return { hash: sent.hash, link: txLink(sent.hash), status: r.status, opResult, diagnostic: diag, pass: r.status === "FAILED" };
  });

  const spending = await readSpending();
  const endBalance = await nativeBalance(sdk, server, accountId);

  const summary = {
    ranAt: new Date().toISOString(),
    builds: Object.fromEntries(Object.entries(builds).map(([k, b]) => [k, { label: b.label, commit: b.commit }])),
    feeCeilingStroops: FEE_CEILING_STROOPS,
    smartAccount: accountId,
    smartAccountBalanceStroops: { start: startBalance.toString(), end: endBalance.toString() },
    policyAfterRun: { spendingLimit: String(spending.spending_limit), cachedTotalSpent: String(spending.cached_total_spent), periodLedgers: spending.period_ledgers },
    results,
  };
  mkdirSync(join(ROOT, "docs/evidence"), { recursive: true });
  writeFileSync(join(ROOT, "docs/evidence/checks.json"), JSON.stringify(summary, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
  console.log(`\nPolicy after run: ${JSON.stringify(summary.policyAfterRun)}`);
  console.log(`Smart account balance: ${startBalance} -> ${endBalance} stroops`);
  console.log(`\n${results.filter(r => r.pass).length}/${results.length} checks matched expectations`);
  for (const r of results) console.log(`  ${r.pass ? "PASS" : "FAIL"} ${r.id} ${r.title}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
