import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { v2 as cloudinary } from 'cloudinary';
import type { Page } from 'playwright';

const usaCloudinary = Boolean(process.env.CLOUDINARY_URL);
if (usaCloudinary) cloudinary.config({ secure: true });

/**
 * Captura la pantalla y devuelve su URL. Con CLOUDINARY_URL definido sube a
 * automatizaciones/<cliente>/<trabajo>/<nombre>; si no, guarda en EVIDENCIAS_DIR.
 */
export async function capturarEvidencia(page: Page, clienteSlug: string, trabajoId: string, nombre: string): Promise<string> {
  const buffer = await page.screenshot({ fullPage: true, type: 'png' });
  if (usaCloudinary) {
    const subido = await new Promise<{ secure_url: string }>((res, rej) => {
      cloudinary.uploader
        .upload_stream({ folder: `automatizaciones/${clienteSlug}/${trabajoId}`, public_id: nombre, resource_type: 'image', overwrite: true }, (err, r) =>
          err || !r ? rej(err ?? new Error('Cloudinary no devolvió resultado')) : res(r),
        )
        .end(buffer);
    });
    return subido.secure_url;
  }
  const dir = resolve(process.env.EVIDENCIAS_DIR ?? './evidencias', clienteSlug, trabajoId);
  await mkdir(dir, { recursive: true });
  const ruta = resolve(dir, `${nombre}.png`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(ruta, buffer);
  return ruta;
}
