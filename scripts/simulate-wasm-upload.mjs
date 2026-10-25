// Simulates uploading a new 46 KB smart-account wasm to testnet and records
// the resource fee the RPC asks for. Nothing is submitted.
//
// The OpenZeppelin example account is already on testnet, so its upload would
// write nothing. To measure a new upload, this appends a custom section with
// random bytes. The code is unchanged but the wasm hash is new.
//
// Usage: node scripts/simulate-wasm-upload.mjs
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as sdk from "@stellar/stellar-sdk";
import { RPC_URL, friendbot } from "./lib/testnet.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OZ_DIR = process.env.OZ_DIR ?? join(ROOT, ".cache/stellar-contracts");
const WASM = join(OZ_DIR, "target/wasm32v1-none/release/multisig_account_example.wasm");
const UINT32_MAX = 4_294_967_295;

function withCustomSection(wasm) {
  const name = Buffer.from("x402-check-nonce");
  const payload = Buffer.concat([Buffer.from([name.length]), name, randomBytes(16)]);
  // Section id 0 (custom), then the payload size as a one-byte LEB128 (< 128).
  return Buffer.concat([wasm, Buffer.from([0, payload.length]), payload]);
}

async function simulateUpload(server, source, wasm) {
  const tx = new sdk.TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: sdk.Networks.TESTNET,
  })
    .addOperation(sdk.Operation.uploadContractWasm({ wasm }))
    .setTimeout(60)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!sdk.rpc.Api.isSimulationSuccess(sim)) throw new Error(sim.error);
  const r = sim.transactionData.build().resources();
  return {
    wasmBytes: wasm.length,
    wasmHash: sdk.hash(wasm).toString("hex"),
    minResourceFeeStroops: Number(sim.minResourceFee),
    writeBytes: r.writeBytes(),
    latestLedger: sim.latestLedger,
  };
}

const server = new sdk.rpc.Server(RPC_URL);
const kp = sdk.Keypair.random();
await friendbot(kp.publicKey());
const source = await server.getAccount(kp.publicKey());
const original = readFileSync(WASM);

const existing = await simulateUpload(server, source, original);
const fresh = await simulateUpload(server, source, withCustomSection(original));
const network = await server.getNetwork();

const out = {
  simulatedAt: new Date().toISOString(),
  rpc: RPC_URL,
  protocolVersion: network.protocolVersion,
  uint32MaxStroops: UINT32_MAX,
  alreadyOnTestnet: existing,
  newWasmSameCode: { ...fresh, exceedsUint32: fresh.minResourceFeeStroops > UINT32_MAX },
};
writeFileSync(join(ROOT, "docs/evidence/wasm-upload-simulation.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
