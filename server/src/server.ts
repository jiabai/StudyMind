import Fastify from 'fastify';

export async function createServer() {
  const server = Fastify({ logger: true });

  server.get('/health/live', async () => ({ status: 'ok' }));

  server.get('/health/ready', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  return server;
}
