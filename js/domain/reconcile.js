export function reconcilePayments({ local = [], remote = null } = {}) {
  if (!remote) {
    return { skipped: true, reason: 'Payment provider keys are not set', mismatches: [] };
  }
  const left = new Map(remote.map((row) => [String(row.reference), row]));
  const mismatches = [];
  for (const row of local) {
    const found = left.get(String(row.reference));
    if (!found) {
      mismatches.push({
        reference: row.reference,
        kind: 'missing_at_provider',
        localCents: row.amountCents,
        providerCents: null,
        provider: row.provider || null,
      });
    } else if (Number(found.amountCents) !== Number(row.amountCents)) {
      mismatches.push({
        reference: row.reference,
        kind: 'amount',
        localCents: row.amountCents,
        providerCents: found.amountCents,
        provider: found.provider || row.provider || null,
      });
    }
    left.delete(String(row.reference));
  }
  for (const extra of left.values()) {
    mismatches.push({
      reference: extra.reference,
      kind: 'missing_locally',
      localCents: null,
      providerCents: extra.amountCents,
      provider: extra.provider || null,
    });
  }
  return { skipped: false, mismatches };
}
