// Reads the fee each payment transaction in docs/evidence/checks.json was
// actually charged, from Horizon, and writes docs/evidence/fees.json.
//
// Usage: node scripts/collect-fees.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HORIZON = "https://horizon-testnet.stellar.org";
const checks = JSON.parse(readFileSync(join(ROOT, "docs/evidence/checks.json"), "utf8"));

const rows = [];
for (const r of checks.results) {
  const hash = r.settle?.transaction || r.hash;
  if (!hash) continue;
  const tx = await (await fetch(`${HORIZON}/transactions/${hash}`)).json();
  rows.push({
    check: r.id,
    payer: r.settle?.payer ?? "smart account",
    hash,
    successful: tx.successful,
    feeChargedStroops: Number(tx.fee_charged),
    ledger: tx.ledger,
  });
}
writeFileSync(join(ROOT, "docs/evidence/fees.json"), JSON.stringify(rows, null, 2) + "\n");
for (const row of rows) console.log(`${row.check}\t${row.successful ? "ok    " : "failed"}\t${row.feeChargedStroops}\t${row.payer}`);
