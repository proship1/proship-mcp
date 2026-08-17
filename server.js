// ProShip MCP — stateless MCP server over the public ProShip API.
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import mcpRoutes from './routes/mcp.js';

export async function buildServer() {
  const app = Fastify({ logger: process.env.NODE_ENV === 'production' });
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Mcp-Protocol-Version', 'MCP-Protocol-Version'],
  });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  app.get('/healthz', async () => ({ ok: true }));
  await app.register(mcpRoutes, { prefix: '/mcp' });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = await buildServer();
  const port = Number(process.env.PORT || 3000);
  app.listen({ port, host: '0.0.0.0' }).catch((e) => { console.error(e); process.exit(1); });
}
