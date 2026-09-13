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

const MAX_ELEMENTOS = 600;

const CODIGO_INSPECCION = `() => {
  const limpiar = (s) => (s ?? '').replace(/\\s+/g, ' ').trim();
  const rolDe = (el) => {
    const r = el.getAttribute('role'); if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a' && el.hasAttribute('href')) return 'link';
    if (t === 'button') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'img') return 'img';
    if (t === 'input') { const ty = (el.getAttribute('type') || 'text').toLowerCase(); if (ty === 'button' || ty === 'submit' || ty === 'reset' || ty === 'image') return 'button'; if (ty === 'checkbox') return 'checkbox'; if (ty === 'radio') return 'radio'; if (ty === 'hidden') return null; return 'textbox'; }
    if (/^h[1-6]$/.test(t)) return 'heading';
    return null;
  };
  const etiquetaDe = (el) => {
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return limpiar(l.textContent); }
    const p = el.closest('label'); if (p) return limpiar(p.textContent);
    const al = el.getAttribute('aria-label'); if (al) return limpiar(al);
    return '';
  };
  const sx = window.scrollX, sy = window.scrollY;
  const todos = Array.from(document.querySelectorAll('a, button, input, select, textarea, label, img, [role], [onclick], h1, h2, h3, h4, th, td, span, b, strong, p, li, dt, dd, div'));
  const conteoRol = {};
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
    const texto = limpiar(t === 'input' || t === 'select' || t === 'textarea' ? (el.getAttribute('value') || el.getAttribute('title') || '') : el.textContent).slice(0, 80);
    if (!interactivo && !texto) continue;
    let indiceRol;
    if (rol) { indiceRol = conteoRol[rol] = (conteoRol[rol] ?? -1) + 1; }
    const nombre = el.getAttribute('aria-label') || el.getAttribute('title') || (t === 'input' ? '' : texto);
    const etiqueta = (t === 'input' || t === 'select' || t === 'textarea') ? etiquetaDe(el) : '';
    const placeholder = el.getAttribute('placeholder') || '';
    const sug = [];
    if (el.id && !/^(j_id|id\\d|:)/.test(el.id) && !/\\d{3,}/.test(el.id)) sug.push({ selector: '#' + CSS.escape(el.id) });
    if (etiqueta && (t === 'input' || t === 'select' || t === 'textarea')) sug.push({ etiqueta });
    if (placeholder) sug.push({ placeholder });
    if (rol && nombre && rol !== 'textbox' && rol !== 'combobox') sug.push({ rol, nombre: nombre.slice(0, 60) });
    if (rol && indiceRol !== undefined && (rol === 'combobox' || rol === 'textbox' || rol === 'checkbox' || rol === 'radio')) sug.push({ rol, indice: indiceRol });
    if (texto && !(t === 'input' || t === 'select' || t === 'textarea')) sug.push({ texto: texto.slice(0, 60), exacto: texto.length <= 60 });
    const name = el.getAttribute('name');
    if (name) sug.push({ selector: t + '[name="' + name.replace(/"/g, '\\\\"') + '"]' });
    if (el.getAttribute('title')) sug.push({ selector: t + '[title="' + el.getAttribute('title').replace(/"/g, '\\\\"') + '"]' });
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
