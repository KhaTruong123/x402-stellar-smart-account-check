// Shared testnet helpers. Every function takes the Stellar SDK instance as an
// argument so callers can pass the copy that a given x402 checkout resolves.
// Mixing two SDK copies breaks XDR `instanceof` checks inside x402.

export const RPC_URL = process.env.STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org";
export const FRIENDBOT_URL = "https://friendbot.stellar.org";
export const NETWORK = "stellar:testnet";
export const EXPLORER = "https://stellar.expert/explorer/testnet";

export const txLink = hash => `${EXPLORER}/tx/${hash}`;
export const contractLink = id => `${EXPLORER}/contract/${id}`;
export const accountLink = id => `${EXPLORER}/account/${id}`;

export async function friendbot(address) {
  const res = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(address)}`);
  if (!res.ok) {
    const body = await res.text();
    // Friendbot answers 400 when the account already exists; that is fine.
    if (!body.includes("createAccountAlreadyExist")) {
      throw new Error(`friendbot ${res.status}: ${body.slice(0, 300)}`);
    }
  }
}

export function nativeAssetId(sdk) {
  return sdk.Asset.native().contractId(sdk.Networks.TESTNET);
}

// Build, simulate, sign with `sourceKp`, submit, and wait for the result.
export async function submitOp(sdk, server, sourceKp, operation) {
  const account = await server.getAccount(sourceKp.publicKey());
  const tx = new sdk.TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase: sdk.Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(120)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(sourceKp);
  const sent = await server.sendTransaction(prepared);
  if (sent.status !== "PENDING") {
    throw new Error(`sendTransaction ${sent.status}: ${JSON.stringify(sent.errorResult ?? {})}`);
  }
  const result = await waitForTx(server, sent.hash);
  if (result.status !== "SUCCESS") {
    throw new Error(`tx ${sent.hash} ended with ${result.status}`);
  }
  return { hash: sent.hash, ledger: result.ledger, returnValue: result.returnValue };
}

export async function waitForTx(server, hash, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    const r = await server.getTransaction(hash);
    if (r.status !== "NOT_FOUND") return r;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error(`tx ${hash} not found after ${attempts}s`);
}

export async function nativeBalance(sdk, server, address) {
  // Read the XLM SAC `balance(address)` through a simulation. Works for G and C.
  const contract = new sdk.Contract(nativeAssetId(sdk));
  const source = new sdk.Account(sdk.Keypair.random().publicKey(), "0");
  const tx = new sdk.TransactionBuilder(source, {
    fee: "100",
    networkPassphrase: sdk.Networks.TESTNET,
  })
    .addOperation(contract.call("balance", new sdk.Address(address).toScVal()))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if (!sdk.rpc.Api.isSimulationSuccess(sim)) throw new Error(`balance sim failed: ${sim.error}`);
  return sdk.scValToNative(sim.result.retval);
}
