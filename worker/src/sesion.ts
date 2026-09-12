/**
 * Abre el portal con navegador visible para que una persona inicie sesión
 * (necesario si el portal tiene captcha o segundo factor) y guarda la sesión
 * cifrada para que el worker la reutilice.
 *
 * Uso: npm run sesion -- <cliente> <portal>
 *      npm run sesion -- cardioib sanitas
 */
import { createInterface } from 'node:readline/promises';
import { cerrarDb, Cliente, conectarDb } from '@startia/core';
import { registro } from '@startia/modulos';
import { cerrarTodo, guardarSesion, obtenerContexto } from './navegador.js';

const [clienteSlug, portal] = process.argv.slice(2);
if (!clienteSlug || !portal) {
  console.error('Uso: npm run sesion -- <cliente> <portal>');
  process.exit(1);
}

const modulo = Object.values(registro).find((m) => m.portal === portal);
if (!modulo) {
  console.error(`No hay módulos para el portal "${portal}". Portales: ${[...new Set(Object.values(registro).map((m) => m.portal))].join(', ')}`);
  process.exit(1);
}

await conectarDb();
try {
  if (!(await Cliente.exists({ slug: clienteSlug }))) {
    console.error(`No existe el cliente "${clienteSlug}"`);
    process.exit(1);
  }
  const ctx = await obtenerContexto(clienteSlug, portal, false);
  const page = await ctx.newPage();
  await page.goto(modulo.urlInicio);

  console.log(`\nInicie sesión en ${modulo.urlInicio} en la ventana que se abrió.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  await rl.question('Cuando vea la pantalla principal del portal, presione Enter aquí para guardar la sesión... ');
  rl.close();

  if (!(await modulo.sesionValida(page))) {
    console.error('El portal no muestra una sesión iniciada. No se guardó nada.');
    process.exit(1);
  }
  await guardarSesion(clienteSlug, portal, ctx, 'manual');
  console.log(`Sesión de ${portal} guardada para ${clienteSlug}. El worker la usará en la próxima consulta.`);
} finally {
  await cerrarTodo();
  await cerrarDb();
}
