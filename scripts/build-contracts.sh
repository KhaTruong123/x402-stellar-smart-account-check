#!/usr/bin/env bash
# Builds the three OpenZeppelin stellar-contracts v0.8.0 example contracts this
# check uses: the smart account, the ed25519 verifier and the spending-limit
# policy. The source is not copied into this repo; it is cloned at the tag.
#
# Output: $OZ_DIR/target/wasm32v1-none/release/*.wasm
set -euo pipefail

OZ_TAG="v0.8.0"
OZ_DIR="${OZ_DIR:-$(cd "$(dirname "$0")/.." && pwd)/.cache/stellar-contracts}"

if [ ! -d "$OZ_DIR/.git" ]; then
  git clone --depth 1 --branch "$OZ_TAG" https://github.com/OpenZeppelin/stellar-contracts.git "$OZ_DIR"
fi
git -C "$OZ_DIR" describe --tags --exact-match

cd "$OZ_DIR"
for pkg in multisig-account-example multisig-ed25519-verifier-example multisig-spending-limit-policy-example; do
  stellar contract build --package "$pkg"
done

for f in multisig_account_example multisig_ed25519_verifier_example multisig_spending_limit_policy_example; do
  wasm="target/wasm32v1-none/release/$f.wasm"
  echo "$(shasum -a 256 "$wasm" | cut -d' ' -f1)  $f.wasm"
done
