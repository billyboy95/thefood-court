export function emailConfigured(env = {}) {
  return Boolean(env.RESEND_API_KEY && env.EMAIL_FROM);
}

/** Resend when keys are set. No-op otherwise. */
export async function sendEmail({ env = {}, to, subject, text, attachments = [], fetchImpl = fetch } = {}) {
  const recipient = String(to || '').trim();
  if (!emailConfigured(env) || !recipient) {
    return { sent: false, skipped: true, reason: 'Email keys or recipient are not set' };
  }
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [recipient],
      subject,
      text,
      attachments: attachments.map((file) => ({
        filename: file.filename,
        content: file.content,
      })),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { sent: false, skipped: false, error: `Email ${res.status}: ${detail.slice(0, 180)}` };
  }
  return { sent: true, skipped: false, provider: 'resend' };
}
