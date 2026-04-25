import { Hono } from 'hono';
import { healthRoute } from './routes/health.js';
import { kapsoWebhookRoute } from './routes/kapsoWebhook.js';

export const app = new Hono();

app.route('/', healthRoute);
app.route('/', kapsoWebhookRoute);

app.notFound((c) => c.json({ error: 'not_found' }, 404));

app.onError((err, c) => {
  c.get('logger' as never);
  return c.json({ error: 'internal_error', message: err.message }, 500);
});
