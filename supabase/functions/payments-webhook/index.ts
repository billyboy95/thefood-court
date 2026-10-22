import { handlePaymentsWebhook } from '../_shared/router.js';

Deno.serve((request) => handlePaymentsWebhook(request));
