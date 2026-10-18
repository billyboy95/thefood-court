import { createApp } from './app.js';

const app = createApp();
const { port, host } = app.ctx.config;
app.server.listen(port, host, () => {
  console.log(`EASTC Food Court listening on http://${host}:${port}`);
});
