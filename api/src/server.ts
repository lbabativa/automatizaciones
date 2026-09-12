import { serve } from '@hono/node-server';
import { conectarDb, envNum } from '@startia/core';
import { app } from './app.js';

const puerto = envNum('PORT', 4000);
await conectarDb();
serve({ fetch: app.fetch, port: puerto }, () => {
  console.log(`API StartIA Automatizaciones escuchando en http://localhost:${puerto}`);
});
