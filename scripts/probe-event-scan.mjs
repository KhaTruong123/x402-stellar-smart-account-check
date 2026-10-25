// Feeds crafted simulation events to the facilitator's event check
// (`validateSimulationEvents`) of each build and prints what it returns.
// No network. Covers shapes the testnet run cannot produce without deploying
// hostile contracts.
//
// Usage: X402_MAIN=... X402_3399=... X402_BOTH=... node scripts/probe-event-scan.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadX402 } from "./lib/x402-checkout.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const builds = [
  loadX402("main", process.env.X402_MAIN),
  loadX402("pr-3399", process.env.X402_3399),
  loadX402("main+3399+3860", process.env.X402_BOTH),
];

// Addresses only; no keys are used.
const ASSET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"; // XLM SAC, testnet
const POLICY = "CCVIHJ2RNUSSC7X2D6GEQTITJL3WPU4IJSB6FMAPJETGW3MJIQZKURFA";
const OTHER_TOKEN = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const PAYER = "CAEIDYUIZZHKI7JVFHOXA2OVQDJ64UG3EZPKYMHDAQNVUGKODMTDL2EG";
const PAYEE = "GBBK6E3HMBIDZGN5FUXKHXKN7X7ZFOBKDOEYYPIETFBPGEC4A6PEHTA4";
const ATTACKER = "GBOMHG4ICNQQA2CR7HYXPTVPJZ25EFOV7RQUPUX4XOBC2HBMHQ5IAKHQ";
const AMOUNT = 10_000_000n;

function cases(sdk) {
  const sym = s => sdk.xdr.ScVal.scvSymbol(s);
  const addr = a => new sdk.Address(a).toScVal();
  const i128 = n => sdk.nativeToScVal(n, { type: "i128" });
  const ev = (emitter, topics, data = sdk.xdr.ScVal.scvVoid(), ok = true) =>
    new sdk.xdr.DiagnosticEvent({
      inSuccessfulContractCall: ok,
      event: new sdk.xdr.ContractEvent({
        ext: new sdk.xdr.ExtensionPoint(0),
        contractId: emitter ? sdk.StrKey.decodeContract(emitter) : null,
        type: sdk.xdr.ContractEventType.contract(),
        body: new sdk.xdr.ContractEventBody(0, new sdk.xdr.ContractEventV0({ topics, data })),
      }),
    });
  // CAP-67 shape seen on testnet: ["transfer", from, to, "native"], data amount.
  const transfer = (from = PAYER, to = PAYEE, amount = AMOUNT, emitter = ASSET) =>
    ev(emitter, [sym("transfer"), addr(from), addr(to), sdk.xdr.ScVal.scvString("native")], i128(amount));
  const policyEvent = ev(POLICY, [sym("spending_limit_enforced"), addr(PAYER)], sdk.xdr.ScVal.scvMap([]));

  return [
    ["P1", "OZ policy event (2 topics, policy emitter), then the transfer (the real testnet order)", [policyEvent, transfer()]],
    ["P2", "transfer only (classic payer baseline)", [transfer()]],
    ["P3", "fake transfer from a foreign contract, no real asset transfer", [transfer(PAYER, PAYEE, AMOUNT, POLICY)]],
    ["P4", "real transfer plus a foreign token transfer payer -> attacker", [transfer(), transfer(PAYER, ATTACKER, 5n * AMOUNT, OTHER_TOKEN)]],
    ["P5", "real transfer plus a second asset transfer payer -> attacker", [transfer(), transfer(PAYER, ATTACKER, AMOUNT)]],
    ["P6", "real transfer plus asset `approve` payer -> attacker", [transfer(), ev(ASSET, [sym("approve"), addr(PAYER), addr(ATTACKER)], sdk.xdr.ScVal.scvVec([i128(AMOUNT), sdk.xdr.ScVal.scvU32(9999999)]))]],
    ["P7", "real transfer plus asset `set_authorized` on the payee", [transfer(), ev(ASSET, [sym("set_authorized"), addr(PAYEE)], sdk.xdr.ScVal.scvBool(false))]],
    ["P8", "real transfer plus asset `burn` from payer", [transfer(), ev(ASSET, [sym("burn"), addr(PAYER)], i128(AMOUNT))]],
    ["P9", "real transfer plus asset `mint` to payer", [transfer(), ev(ASSET, [sym("mint"), addr(PAYER), addr(PAYER)], i128(AMOUNT))]],
    ["P10", "real transfer plus a rolled-back asset transfer (inSuccessfulContractCall false)", [transfer(), ev(ASSET, [sym("transfer"), addr(PAYER), addr(ATTACKER)], i128(AMOUNT), false)]],
    ["P11", "foreign event with no topics, then the transfer", [ev(POLICY, []), transfer()]],
    ["P12", "contract event with no emitter id, then the transfer", [ev(null, [sym("spending_limit_enforced")]), transfer()]],
    ["P13", "asset transfer to the wrong payee only", [transfer(PAYER, ATTACKER)]],
  ];
}

const rows = [];
for (const build of builds) {
  const signer = build.createEd25519Signer(build.sdk.Keypair.random().secret(), "stellar:testnet");
  const facilitator = new build.Facilitator([signer]);
  for (const [id, title, events] of cases(build.sdk)) {
    const quiet = console.error;
    console.error = () => {};
    const res = facilitator.validateSimulationEvents(events, PAYER, PAYEE, AMOUNT, ASSET);
    console.error = quiet;
    rows.push({ id, title, build: build.label, commit: build.commit, result: res ? res.invalidReason : "accepted" });
  }
}

const byCase = new Map();
for (const r of rows) {
  if (!byCase.has(r.id)) byCase.set(r.id, { id: r.id, title: r.title });
  byCase.get(r.id)[r.build] = r.result;
}
const table = [...byCase.values()];
writeFileSync(join(ROOT, "docs/evidence/event-scan-probe.json"), JSON.stringify({ builds: builds.map(b => ({ label: b.label, commit: b.commit })), cases: table }, null, 2) + "\n");
for (const row of table) {
  console.log(`${row.id}\t${row.title}`);
  for (const b of builds) console.log(`\t${b.label.padEnd(16)} ${row[b.label]}`);
}
