# Despliegue

Arquitectura recomendada: **API en Vercel** (URL pública con HTTPS) y **worker local** en un PC de la clínica. El worker solo sale hacia afuera a buscar trabajos en Mongo, así que en la clínica no se abre ningún puerto ni se expone ninguna IP.

```
Cliente (CardioIB, hoja de cálculo, WhatsApp)
        │  HTTPS + x-api-key
        ▼
   API en Vercel ──► MongoDB Atlas (cola de trabajos)
                          ▲
                          │  el worker jala trabajos (solo salida)
                   Worker local (PC de la clínica, con navegador)
                          │
                          ▼
                   Portal Sanitas / otros
```

## 1. API en Vercel

Requisitos: una cuenta de Vercel y el CLI (ya instalado, `vercel --version`).

```bash
cd C:\StartIA\automatizaciones
vercel login            # abre el navegador para autenticarse (esto lo haces tú)
vercel link             # crea/vincula el proyecto (elige alcance y nombre)
```

Cargar las variables de entorno del proyecto (produccion). La API NO necesita `MASTER_KEY`: la llave que descifra las credenciales de los portales vive solo en el worker local.

```bash
vercel env add MONGODB_URI production      # la cadena de Atlas con usuario/clave
vercel env add ADMIN_KEY production        # clave de la consola /admin
# opcionales:
vercel env add SYNC_TIMEOUT_MS production   # p. ej. 90000
vercel env add CACHE_HORAS production       # p. ej. 12
```

Desplegar:

```bash
vercel deploy           # despliegue de prueba (preview), para verificar
vercel deploy --prod    # cuando el preview funcione, a produccion
```

Verificar (reemplaza la URL por la que entrega Vercel):

```bash
curl https://<tu-proyecto>.vercel.app/v1/salud
```

La consola de operador queda en `https://<tu-proyecto>.vercel.app/admin`.

Notas de Vercel:
- El `vercel.json` ya declara la función y empaqueta el panel (`api/public`).
- El worker, los perfiles y las evidencias quedan excluidos por `.vercelignore`.
- Con la API remota, las capturas deben ir a **Cloudinary** (ver worker), porque Vercel no puede servir archivos del PC de la clínica.

## 2. Worker en el PC de la clínica

Requisitos en ese PC: Node 20+, el Chromium propio (o `npx playwright install chromium`) y el archivo `.env.local` con `MONGODB_URI`, `MASTER_KEY`, `DNS_SERVERS` si el DNS local no resuelve SRV, `HEADLESS=false` y, para que las capturas lleguen a la nube, `CLOUDINARY_URL`.

```bash
cd C:\StartIA\automatizaciones
npm install
npm run worker
```

O con el acceso directo `worker\start-worker.cmd`.

**Importante:** el worker debe correr en una sesión de escritorio abierta, no como servicio oculto. Colsanitas exige un login manual la primera vez (protección Radware) y eso necesita una ventana visible. Para que arranque solo al iniciar sesión en Windows:

1. Abrir la carpeta de inicio: tecla Windows + R, escribir `shell:startup`, Enter.
2. Crear ahí un acceso directo a `C:\StartIA\automatizaciones\worker\start-worker.cmd`.

Así, cuando alguien inicia sesión en ese PC, el worker queda corriendo. La primera consulta abre la ventana para iniciar sesión en el portal; de ahí en adelante reutiliza esa sesión.

## 3. Registrar clientes

Desde cualquier equipo con acceso a la misma base:

```bash
CRED_SANITAS_USUARIO=... CRED_SANITAS_PASSWORD=... npm run cliente:crear -- --slug <slug> --nombre "<Nombre>" --modulo <modulo> --config <modulo>.<clave>=<valor>
```

Y se administran desde la consola `/admin`.
