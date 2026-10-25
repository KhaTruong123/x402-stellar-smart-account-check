// Summarizes Soroban contract events (emitter, name, topic count) so the
// evidence shows which events the facilitator's scan saw and in what order.

function summarize(sdk, event) {
  const contractId = event.contractId();
  const topics = event.body().v0().topics();
  const first = topics[0];
  return {
    emitter: contractId ? sdk.StrKey.encodeContract(contractId) : null,
    name: first?.switch().name === "scvSymbol" ? first.sym().toString() : first?.switch().name ?? null,
    topicCount: topics.length,
    topics: topics.slice(1).map(t => {
      try {
        return String(sdk.scValToNative(t));
      } catch {
        return t.switch().name;
      }
    }),
  };
}

// Contract-type events from a simulation (DiagnosticEvent[]).
export function simulationContractEvents(sdk, diagnosticEvents = []) {
  return diagnosticEvents
    .map(d => d.event())
    .filter(e => e.type().name === "contract")
    .map(e => summarize(sdk, e));
}

// Contract events from a confirmed transaction (getTransaction response).
export function transactionContractEvents(sdk, txResponse) {
  const perOp = txResponse.events?.contractEventsXdr ?? [];
  return perOp.flat().map(e => summarize(sdk, e));
}
