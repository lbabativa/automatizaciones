// Punto de entrada serverless para Vercel. En local se usa src/server.ts.
// La conexión a Mongo se asegura en el primer request desde src/app.ts.
import { handle } from 'hono/vercel';
import { app } from './src/app.js';

export const config = { runtime: 'nodejs' };

export default handle(app);
