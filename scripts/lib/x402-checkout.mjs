// Loads `@x402/stellar` from a local x402 checkout that has been built
// (`pnpm --filter @x402/stellar... build`). The Stellar SDK is resolved from
// the same package so XDR objects passed into x402 come from the same copy.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

export function loadX402(label, repoDir) {
  if (!repoDir) throw new Error(`missing checkout path for ${label}`);
  const pkgDir = join(repoDir, "typescript/packages/mechanisms/stellar");
  const req = createRequire(join(pkgDir, "package.json"));
  const commit = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"]).toString().trim();
  return {
    label,
    commit,
    sdk: req("@stellar/stellar-sdk"),
    Client: req(join(pkgDir, "dist/cjs/exact/client/index.js")).ExactStellarScheme,
    Facilitator: req(join(pkgDir, "dist/cjs/exact/facilitator/index.js")).ExactStellarScheme,
    createEd25519Signer: req(join(pkgDir, "dist/cjs/index.js")).createEd25519Signer,
  };
}
