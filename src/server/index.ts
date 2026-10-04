import { loadConfig } from './config.js';
import { createApp } from './app.js';

try {
  const config = loadConfig();
  const { app } = await createApp(config, { logger: true });
  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    const deadline = setTimeout(() => process.exit(1), 10000); deadline.unref();
    await app.close(); clearTimeout(deadline);
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  await app.listen({ host: config.HOST, port: config.PORT });
} catch {
  console.error('Calendar could not start. Check the application origin, CalDAV URL, and configuration.');
  process.exitCode = 1;
}
