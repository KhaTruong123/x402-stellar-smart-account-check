// Helpers for the over-limit case.
//
// The x402 client re-simulates after signing, so an over-limit payment fails
// inside the client and never reaches a facilitator. To check that the
// facilitator and the network refuse it too, these helpers build the same
// signed payload without the client's second simulation.

export async function signedTransferWithoutClientCheck(sdk, { signer, requirements, rpcUrl }) {
  const server = new sdk.rpc.Server(rpcUrl);
  const tx = await sdk.contract.AssembledTransaction.build({
    contractId: requirements.asset,
    method: "transfer",
    args: [
      sdk.nativeToScVal(signer.address, { type: "address" }),
      sdk.nativeToScVal(requirements.payTo, { type: "address" }),
      sdk.nativeToScVal(requirements.amount, { type: "i128" }),
    ],
    networkPassphrase: sdk.Networks.TESTNET,
    rpcUrl,
    parseResultXdr: result => result,
  });
  const { sequence } = await server.getLatestLedger();
  await tx.signAuthEntries({
    address: signer.address,
    signAuthEntry: signer.signAuthEntry,
    expiration: sequence + 20,
    authorizeEntry: signer.authorizeEntry,
  });
  return tx.built.toXDR();
}

function sorobanDataOf(sdk, txXdr) {
  const tx = new sdk.Transaction(txXdr, sdk.Networks.TESTNET);
  return tx.toEnvelope().v1().tx().ext().sorobanData();
}

// Submits `overCapXdr` straight to the network, paid by `sourceKp`, so the
// refusal is recorded on-chain. The recording-mode footprint of the over-limit
// transaction lacks the keys that `__check_auth` reads, so they are taken from
// a within-limit transaction that the client simulated with real auth.
export async function submitOverCapOnChain(sdk, { server, sourceKp, overCapXdr, withinCapXdr }) {
  const a = sorobanDataOf(sdk, overCapXdr);
  const b = sorobanDataOf(sdk, withinCapXdr);
  const key = k => k.toXDR("base64");
  const rw = new Map();
  for (const d of [a, b]) for (const k of d.resources().footprint().readWrite()) rw.set(key(k), k);
  const ro = new Map();
  for (const d of [a, b]) {
    for (const k of d.resources().footprint().readOnly()) if (!rw.has(key(k))) ro.set(key(k), k);
  }
  const rb = b.resources();
  const sorobanData = new sdk.SorobanDataBuilder()
    .setFootprint([...ro.values()], [...rw.values()])
    .setResources(rb.instructions() * 2, rb.diskReadBytes() * 2, rb.writeBytes() * 2)
    .setResourceFee(20_000_000)
    .build();

  const inner = new sdk.Transaction(overCapXdr, sdk.Networks.TESTNET);
  const op = inner.operations[0];
  const tx = new sdk.TransactionBuilder(await server.getAccount(sourceKp.publicKey()), {
    fee: "1000",
    networkPassphrase: sdk.Networks.TESTNET,
    sorobanData,
  })
    .addOperation(sdk.Operation.invokeHostFunction({ func: op.func, auth: op.auth }))
    .setTimeout(60)
    .build();
  tx.sign(sourceKp);
  const sent = await server.sendTransaction(tx);
  return sent;
}
