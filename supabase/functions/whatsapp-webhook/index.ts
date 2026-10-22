import { handleWhatsAppWebhook } from '../_shared/router.js';

Deno.serve((request) => handleWhatsAppWebhook(request));
