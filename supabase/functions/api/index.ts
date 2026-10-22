import { handleApi } from '../_shared/router.js';

Deno.serve((request) => handleApi(request));
