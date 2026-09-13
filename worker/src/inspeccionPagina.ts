/**
 * Inspección de la página para el editor de flujos: extrae los elementos visibles
 * (interactivos y hojas de texto) con su caja sobre la captura a página completa,
 * y sugiere objetivos estables para cada uno. Se guarda en la colección
 * `inspecciones` asociada a un trabajo de prueba y al nombre de la captura.
 *
 * El código que corre en el navegador va como texto y sin funciones con nombre:
 * bajo tsx/esbuild, esas funciones llegan a la página con un helper __name que allí no existe.
 */
import { Inspeccion, type ElementoInspeccion } from '@startia/core';
import type { Page } from 'playwright';
import type { Types } from 'mongoose';
import { CODIGO_SUGERENCIAS } from './sugerencias.js';

const MAX_ELEMENTOS = 600;

const CODIGO_INSPECCION = `() => {
  ${CODIGO_SUGERENCIAS}
  const sx = window.scrollX, sy = window.scrollY;
  const todos = Array.from(document.querySelectorAll('a, button, input, select, textarea, label, img, [role], [onclick], h1, h2, h3, h4, th, td, span, b, strong, p, li, dt, dd, div'));
  const salida = [];
  for (const el of todos) {
    const t = el.tagName.toLowerCase();
    const rol = rolDe(el);
    const interactivo = rol !== null || el.hasAttribute('onclick');
    const esHoja = el.children.length === 0 || Array.from(el.children).every((c) => c.tagName === 'BR' || c.tagName === 'B' || c.tagName === 'I' || c.tagName === 'STRONG' || c.tagName === 'EM' || c.tagName === 'SPAN');
    if (!interactivo && !esHoja) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    const st = window.getComputedStyle(el);
    if (st.visibility === 'hidden' || st.display === 'none') continue;
    const d = describir(el);
    const texto = d.texto;
    if (!interactivo && !texto) continue;
    const indiceRol = rol ? indiceRolDe(el, rol) : undefined;
    const etiqueta = d.etiqueta, placeholder = d.placeholder, name = d.name;
    const sug = sugerir(el);
    if (!sug.length) continue;
    salida.push({ tag: t, texto, caja: [Math.round(r.left + sx), Math.round(r.top + sy), Math.round(r.width), Math.round(r.height)], id: el.id || undefined, name: name || undefined, placeholder: placeholder || undefined, rol: rol || undefined, etiqueta: etiqueta || undefined, tipo: t === 'input' ? (el.getAttribute('type') || 'text') : undefined, indiceRol, sugerencias: sug });
    if (salida.length >= ${MAX_ELEMENTOS}) break;
  }
  return { url: location.href, ancho: Math.max(document.documentElement.scrollWidth, document.documentElement.clientWidth), alto: Math.max(document.documentElement.scrollHeight, document.documentElement.clientHeight), elementos: salida };
}`;

export async function inspeccionarPagina(page: Page, trabajoId: Types.ObjectId, captura: string): Promise<number> {
  const datos = (await page.evaluate(`(${CODIGO_INSPECCION})()`)) as { url: string; ancho: number; alto: number; elementos: ElementoInspeccion[] };
  await Inspeccion.updateOne(
    { trabajoId, captura },
    { $set: { url: datos.url, ancho: datos.ancho, alto: datos.alto, elementos: datos.elementos, createdAt: new Date() } },
    { upsert: true },
  );
  return datos.elementos.length;
}
