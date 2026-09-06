// A real service with NO dependency on K. Version is stamped in artifact bytes.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const version = 'VERSION_PLACEHOLDER';
const dir = process.argv[2];
const startId = randomUUID();
let quiesced = false;
const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/quiesce') quiesced = true;
  if (req.method === 'POST' && req.url === '/resume') quiesced = false;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ version, pid: process.pid, startId, quiesced }));
  if (req.method === 'POST' && req.url === '/stop') {
    server.close(() => process.exit(0));
    server.closeAllConnections();
  }
});
server.listen(0, '127.0.0.1', async () => {
  await writeFile(join(dir, 'endpoint.json'), JSON.stringify({ port: server.address().port, pid: process.pid, startId }));
});
