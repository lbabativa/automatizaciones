// Punto de entrada para Vercel (detección automática de Hono). En local se usa src/server.ts.
import { conectarDb } from '@startia/core';
import { app } from './src/app.js';

await conectarDb();
export default app;
