// SPDX-License-Identifier: GPL-3.0-only
// Mail Guardian Hono entrypoint.

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createServer, getServerPort } from '@devvit/web/server';
import { menu } from './routes/menu';
import { triggers } from './routes/triggers';

const app = new Hono();
const internal = new Hono();

internal.route('/menu', menu);
internal.route('/triggers', triggers);

app.route('/internal', internal);

app.get('/', (c) => c.json({ name: 'mailguardian', status: 'ok' }));

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});
