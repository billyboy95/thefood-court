/** Send the browser to Yoco or PayFast when the provider returned a checkout. */
export function paymentHandoff(payment) {
  if (!payment || payment.status === 'paid' || payment.mode === 'stub' || payment.demo) return null;
  if (payment.redirectUrl) return { type: 'redirect', url: payment.redirectUrl };
  if (payment.url && payment.fields) return { type: 'form', url: payment.url, fields: payment.fields };
  return null;
}

export function followPayment(payment, doc = document) {
  const handoff = paymentHandoff(payment);
  if (!handoff || !doc) return false;
  if (handoff.type === 'redirect') {
    doc.defaultView.location.href = handoff.url;
    return true;
  }
  const form = doc.createElement('form');
  form.method = 'POST';
  form.action = handoff.url;
  for (const [key, value] of Object.entries(handoff.fields)) {
    const input = doc.createElement('input');
    input.type = 'hidden';
    input.name = key;
    input.value = String(value);
    form.appendChild(input);
  }
  doc.body.appendChild(form);
  form.submit();
  return true;
}
