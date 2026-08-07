import { createServer } from './server.js';

const port = parseInt(process.env.PORT || '8788', 10);
const host = process.env.HOST || '0.0.0.0';

const server = await createServer();

try {
  await server.listen({ port, host });
  console.log(`StudyMind server listening on http://${host}:${port}`);
} catch (err) {
  console.error('Failed to start server:', err);
  process.exit(1);
}
