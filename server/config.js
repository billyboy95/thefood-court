/**
 * Placeholders only. Never put a live secret in the repo.
 * Billy replaces the PLACEHOLDER values in the host environment.
 */
export function loadConfig(env = process.env) {
  const yocoSecret = env.YOCO_SECRET_KEY || 'sk_test_PLACEHOLDER';
  const yocoWebhook = env.YOCO_WEBHOOK_SECRET || 'whsec_PLACEHOLDER';
  const testFlag = env.YOCO_TEST_MODE;
  const looksPlaceholder = (value) => !value || String(value).includes('PLACEHOLDER');
  return {
    port: Number(env.PORT || 5173),
    host: env.HOST || '0.0.0.0',
    dbPath: env.DATABASE_PATH || 'data/foodcourt.sqlite',
    yocoSecretKey: yocoSecret,
    yocoPublicKey: env.YOCO_PUBLIC_KEY || 'pk_test_PLACEHOLDER',
    yocoWebhookSecret: yocoWebhook,
    // Test mode stays on unless Billy explicitly turns it off AND supplies a real secret.
    yocoTestMode: !(testFlag === '0' && !looksPlaceholder(yocoSecret)),
    whatsappProvider: (env.WHATSAPP_PROVIDER || 'mock').toLowerCase(),
    whatsappCloudToken: env.WHATSAPP_CLOUD_TOKEN || 'PLACEHOLDER',
    whatsappCloudPhoneId: env.WHATSAPP_CLOUD_PHONE_ID || 'PLACEHOLDER',
    birdApiKey: env.BIRD_API_KEY || 'PLACEHOLDER',
    birdChannelId: env.BIRD_CHANNEL_ID || 'PLACEHOLDER',
    twilioSid: env.TWILIO_ACCOUNT_SID || 'PLACEHOLDER',
    twilioToken: env.TWILIO_AUTH_TOKEN || 'PLACEHOLDER',
    twilioFrom: env.TWILIO_WHATSAPP_FROM || 'PLACEHOLDER',
    kitchenWhatsapp: env.KITCHEN_WHATSAPP || 'PLACEHOLDER',
    tillWhatsapp: env.TILL_WHATSAPP || 'PLACEHOLDER',
    qrSecret: env.QR_SECRET || 'PLACEHOLDER_QR_SECRET',
    softposLinkTemplate:
      env.YOCO_SOFTPOS_LINK_TEMPLATE || 'yoco://softpos?amount={amount}&reference={reference}',
    paymentLinkTemplate: env.YOCO_PAYMENT_LINK_TEMPLATE || '',
    crmSyncUrl: env.CRM_SYNC_URL || 'PLACEHOLDER',
    cookieDomain: env.AUTH_COOKIE_DOMAIN || '',
    issuer: env.AUTH_ISSUER || '',
    demoLoginPage: env.DEMO_LOGIN_PAGE !== '0',
    accessTtlSec: Number(env.ACCESS_TTL_SECONDS || 60 * 15),
    refreshTtlSec: Number(env.REFRESH_TTL_SECONDS || 60 * 60 * 24 * 30),
    rememberTtlSec: Number(env.REMEMBER_TTL_SECONDS || 60 * 60 * 24 * 90),
    vapidSubject: env.VAPID_SUBJECT || 'mailto:foodcourt@thefood-court.co.za',
    vapidPublic: env.VAPID_PUBLIC_KEY || 'PLACEHOLDER',
    vapidPrivate: env.VAPID_PRIVATE_KEY || 'PLACEHOLDER',
  };
}

export function isPlaceholder(value) {
  return !value || String(value).includes('PLACEHOLDER');
}
