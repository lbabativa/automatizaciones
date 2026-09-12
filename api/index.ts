// Punto de entrada serverless para Vercel. En local se usa src/server.ts.
// La conexión a Mongo se asegura en el primer request desde src/app.ts.
// El runtime de Node de Vercel ignora lo que devuelve el `export default` (firma (req, res));
// los handlers estilo Web (Request -> Response) se declaran con un export llamado `fetch`.
import { handle } from 'hono/vercel';
import { app } from './src/app.js';

export const config = { runtime: 'nodejs' };

export const fetch = handle(app);
