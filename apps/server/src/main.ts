import { resolve } from 'node:path';
import { createApp } from './app.js';
const port = Number(process.env.PORT || 4100);
const runtime = await createApp({ directory: resolve(process.env.DATA_DIR || '.data'), port, webPort: Number(process.env.WEB_PORT || 5173), agentBasePort: Number(process.env.AGENT_BASE_PORT || 4201), allowedOrigins: process.env.ALLOWED_AGENT_ORIGINS?.split(',').map(s => s.trim()).filter(Boolean) });
const server = runtime.app.listen(port, '127.0.0.1', () => console.log(`Platform ready at http://127.0.0.1:${port}`));
function stop() { server.close(() => { runtime.close(); process.exit(0); }); server.closeAllConnections(); }
process.once('SIGINT', stop); process.once('SIGTERM', stop);
