/**
 * Abre el portal con navegador visible para que una persona inicie sesión
 * (necesario si el portal tiene captcha o segundo factor) y guarda la sesión
 * cifrada para que el worker la reutilice.
 *
 * Uso: npm run sesion -- <cliente> <portal>
 *      npm run sesion -- cardioib sanitas
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { cerrarDb, Cliente, conectarDb } from '@startia/core';
import { registro } from '@startia/modulos';
import type { Page } from 'playwright';
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
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto(modulo.urlInicio);

  console.log(`\nInicie sesión en ${modulo.urlInicio} en la ventana que se abrió.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const dirDiag = resolve('inspeccion', portal);
  let intento = 0;
  let guardada = false;

  while (!guardada) {
    const respuesta = (await rl.question('\nCuando vea la pantalla principal del portal, presione Enter para guardar. Escriba "forzar" para guardar sin verificar, o "fin" para salir: ')).trim().toLowerCase();
    if (respuesta === 'fin') break;
    intento++;

    // El SSO puede abrir otra pestaña: se revisan todas y se usa la que tenga sesión.
    let valida: Page | null = null;
    for (const p of ctx.pages()) {
      if (await modulo.sesionValida(p).catch(() => false)) {
        valida = p;
        break;
      }
    }

    if (valida || respuesta === 'forzar') {
      await guardarSesion(clienteSlug, portal, ctx, 'manual');
      guardada = true;
      console.log(`\nSesión de ${portal} guardada para ${clienteSlug}${valida ? '' : ' (forzada, sin verificar)'}. El worker la usará en la próxima consulta.`);
      break;
    }

    console.log('\nNo detecté una sesión iniciada. Esto es lo que veo en cada pestaña:');
    await mkdir(dirDiag, { recursive: true });
    let i = 0;
    for (const p of ctx.pages()) {
      i++;
      const url = p.url();
      const titulo = await p.title().catch(() => '');
      console.log(`  pestaña ${i}: ${titulo || '(sin título)'}  ${url}`);
      const base = resolve(dirDiag, `sesion-intento${intento}-pestana${i}`);
      await p.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => undefined);
      await writeFile(`${base}.html`, await p.content().catch(() => ''), 'utf8');
    }
    console.log(`  Guardé captura y HTML en ${dirDiag} para revisar la detección.`);
    console.log('  Si ya está dentro del portal y ve el formulario de búsqueda, escriba "forzar".');
  }
  rl.close();
  if (!guardada) console.log('No se guardó ninguna sesión.');
} finally {
  await cerrarTodo();
  await cerrarDb();
}
