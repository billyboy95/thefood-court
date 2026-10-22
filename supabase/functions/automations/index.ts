import { handleAutomations } from '../_shared/router.js';

Deno.serve((request) => handleAutomations(request));
