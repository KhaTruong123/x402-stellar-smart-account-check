// Deploys the capped smart account on Stellar testnet.
//
// Uses the OpenZeppelin stellar-contracts v0.8.0 example contracts as built by
// scripts/build-contracts.sh. The account is deployed with one rule:
//   rule 0, Default, owner key, no policy.
// The owner then signs `add_context_rule` to create:
//   rule 1, CallContract(XLM SAC), agent key, spending-limit policy.
// The agent key is not a signer on rule 0, so every agent payment goes
// through the cap.
//
// Writes secrets to .state/testnet.json (git-ignored) and public addresses
// plus transaction hashes to docs/evidence/setup.json.
//
// Usage: node scripts/setup-testnet.mjs
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "@stellar/stellar-sdk";
import { buildAuthPayload, externalSigner } from "./lib/smart-account-auth.mjs";
import {
  RPC_URL,
  accountLink,
  contractLink,
  friendbot,
  nativeAssetId,
  nativeBalance,
  submitOp,
  txLink,
  waitForTx,
} from "./lib/testnet.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OZ_DIR = process.env.OZ_DIR ?? join(ROOT, ".cache/stellar-contracts");
const WASM_DIR = join(OZ_DIR, "target/wasm32v1-none/release");

// 10 XLM per rolling window of 17,280 ledgers (about one day).
const SPENDING_LIMIT_STROOPS = 100_000_000n;
const PERIOD_LEDGERS = 17_280;
const ACCOUNT_FUNDING_STROOPS = 500_000_000n; // 50 XLM

const server = new sdk.rpc.Server(RPC_URL);
const sym = s => sdk.xdr.ScVal.scvSymbol(s);
const evidence = { network: "stellar:testnet", rpc: RPC_URL, createdAt: new Date().toISOString() };
const txs = [];

function record(step, result) {
  txs.push({ step, hash: result.hash, ledger: result.ledger, link: txLink(result.hash) });
  console.log(`  ${step}: ${result.hash}`);
}

async function upload(kp, file) {
  const wasm = readFileSync(join(WASM_DIR, file));
  const result = await submitOp(sdk, server, kp, sdk.Operation.uploadContractWasm({ wasm }));
  record(`upload ${file}`, result);
  return sdk.hash(wasm);
}

async function deploy(kp, label, wasmHash, constructorArgs = []) {
  const result = await submitOp(
    sdk,
    server,
    kp,
    sdk.Operation.createCustomContract({
      address: new sdk.Address(kp.publicKey()),
      wasmHash,
      salt: randomBytes(32),
      constructorArgs,
    }),
  );
  record(`deploy ${label}`, result);
  return sdk.scValToNative(result.returnValue);
}

// Submits an operation whose only auth entry belongs to the smart account,
// signed by an External signer of that account.
async function submitSmartAccountCall(sourceKp, auth, operation) {
  const account = await server.getAccount(sourceKp.publicKey());
  const draft = new sdk.TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: sdk.Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(120)
    .build();
  const recorded = await server.simulateTransaction(draft);
  if (!sdk.rpc.Api.isSimulationSuccess(recorded)) throw new Error(recorded.error);
  const { sequence } = await server.getLatestLedger();
  const signedAuth = await Promise.all(
    recorded.result.auth.map(entry =>
      sdk.authorizeEntry(
        entry,
        async (_preimage, payload) => ({ signatureScVal: buildAuthPayload(sdk, { ...auth, payload }) }),
        sequence + 100,
        sdk.Networks.TESTNET,
      ),
    ),
  );
  const op = draft.operations[0];
  const withAuth = new sdk.TransactionBuilder(await server.getAccount(sourceKp.publicKey()), {
    fee: "1000000",
    networkPassphrase: sdk.Networks.TESTNET,
  })
    .addOperation(sdk.Operation.invokeHostFunction({ func: op.func, auth: signedAuth }))
    .setTimeout(120)
    .build();
  // prepareTransaction re-simulates with the signed entry, so __check_auth runs.
  const prepared = await server.prepareTransaction(withAuth);
  prepared.sign(sourceKp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status !== "PENDING") throw new Error(`sendTransaction ${sent.status}`);
  const result = await waitForTx(server, sent.hash);
  if (result.status !== "SUCCESS") throw new Error(`tx ${sent.hash} ended with ${result.status}`);
  return { hash: sent.hash, ledger: result.ledger };
}

async function main() {
  const keys = {
    deployer: sdk.Keypair.random(),
    facilitator: sdk.Keypair.random(),
    payee: sdk.Keypair.random(),
    classicPayer: sdk.Keypair.random(),
    owner: sdk.Keypair.random(),
    agent: sdk.Keypair.random(),
  };

  console.log("Funding classic accounts with friendbot");
  for (const name of ["deployer", "facilitator", "payee", "classicPayer"]) {
    await friendbot(keys[name].publicKey());
  }

  console.log("Uploading wasm");
  const verifierHash = await upload(keys.deployer, "multisig_ed25519_verifier_example.wasm");
  const policyHash = await upload(keys.deployer, "multisig_spending_limit_policy_example.wasm");
  const accountHash = await upload(keys.deployer, "multisig_account_example.wasm");

  console.log("Deploying contracts");
  const verifierId = await deploy(keys.deployer, "ed25519 verifier", verifierHash);
  const policyId = await deploy(keys.deployer, "spending-limit policy", policyHash);

  const tokenId = nativeAssetId(sdk);
  const signers = kp =>
    sdk.xdr.ScVal.scvVec([externalSigner(sdk, verifierId, kp.rawPublicKey())]);
  const policyParams = sdk.xdr.ScVal.scvMap([
    new sdk.xdr.ScMapEntry({ key: sym("period_ledgers"), val: sdk.xdr.ScVal.scvU32(PERIOD_LEDGERS) }),
    new sdk.xdr.ScMapEntry({
      key: sym("spending_limit"),
      val: sdk.nativeToScVal(SPENDING_LIMIT_STROOPS, { type: "i128" }),
    }),
  ]);
  const agentPolicies = sdk.xdr.ScVal.scvMap([
    new sdk.xdr.ScMapEntry({ key: new sdk.Address(policyId).toScVal(), val: policyParams }),
  ]);
  const accountId = await deploy(keys.deployer, "smart account (rule 0: owner)", accountHash, [
    signers(keys.owner),
    sdk.xdr.ScVal.scvMap([]),
  ]);

  console.log("Owner adds rule 1: agent key, XLM only, spending-limit policy");
  const addRule = await submitSmartAccountCall(
    keys.deployer,
    { accountId, verifierId, signerKp: keys.owner, contextRuleId: 0 },
    new sdk.Contract(accountId).call(
      "add_context_rule",
      sdk.xdr.ScVal.scvVec([sym("CallContract"), new sdk.Address(tokenId).toScVal()]),
      sdk.nativeToScVal("agent", { type: "string" }),
      sdk.xdr.ScVal.scvVoid(),
      signers(keys.agent),
      agentPolicies,
    ),
  );
  record("add_context_rule (agent, spending limit)", addRule);

  console.log("Funding the smart account with XLM through the SAC");
  const fund = await submitOp(
    sdk,
    server,
    keys.deployer,
    new sdk.Contract(tokenId).call(
      "transfer",
      new sdk.Address(keys.deployer.publicKey()).toScVal(),
      new sdk.Address(accountId).toScVal(),
      sdk.nativeToScVal(ACCOUNT_FUNDING_STROOPS, { type: "i128" }),
    ),
  );
  record("fund smart account (50 XLM)", fund);

  const balance = await nativeBalance(sdk, server, accountId);
  console.log(`  smart account balance: ${balance} stroops`);

  const state = {
    network: "stellar:testnet",
    secrets: Object.fromEntries(Object.entries(keys).map(([k, kp]) => [k, kp.secret()])),
    contracts: { tokenId, verifierId, policyId, accountId },
    agentContextRuleId: 1,
    spendingLimitStroops: SPENDING_LIMIT_STROOPS.toString(),
    periodLedgers: PERIOD_LEDGERS,
  };
  mkdirSync(join(ROOT, ".state"), { recursive: true });
  writeFileSync(join(ROOT, ".state/testnet.json"), JSON.stringify(state, null, 2));

  Object.assign(evidence, {
    accounts: Object.fromEntries(
      ["deployer", "facilitator", "payee", "classicPayer"].map(k => [
        k,
        { address: keys[k].publicKey(), link: accountLink(keys[k].publicKey()) },
      ]),
    ),
    signerPublicKeys: {
      owner: keys.owner.rawPublicKey().toString("hex"),
      agent: keys.agent.rawPublicKey().toString("hex"),
    },
    contracts: Object.fromEntries(
      Object.entries(state.contracts).map(([k, id]) => [k, { id, link: contractLink(id) }]),
    ),
    agentRule: {
      id: 1,
      type: `CallContract(${tokenId})`,
      spendingLimitStroops: state.spendingLimitStroops,
      periodLedgers: PERIOD_LEDGERS,
    },
    ozStellarContracts: "v0.8.0",
    wasmHashes: {
      account: accountHash.toString("hex"),
      ed25519Verifier: verifierHash.toString("hex"),
      spendingLimitPolicy: policyHash.toString("hex"),
    },
    smartAccountStartingBalanceStroops: balance.toString(),
    transactions: txs,
  });
  mkdirSync(join(ROOT, "docs/evidence"), { recursive: true });
  writeFileSync(join(ROOT, "docs/evidence/setup.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log("Done. Public record: docs/evidence/setup.json");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
