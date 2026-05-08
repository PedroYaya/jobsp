# Jobsp

Herramienta local: lee un **CV** y un **listado de empresas** (PDFs), genera JSON, corre un **scan** con Chrome (Puppeteer) y opcionalmente OpenAI, y muestra un **reporte** en el navegador.

---

## Antes de empezar (PDFs y CV de Pedro)

En la carpeta **`pdfs/`** no subas datos ajenos al repo si es público. Para usar **tu propio CV**:

1. **Borrá** el PDF de CV que no sea tuyo (por ejemplo `Pedro-Yaya-Fullstack-Developer-Resume.pdf` si estaba de ejemplo).
2. **Poné tu CV** en `pdfs/` en formato **`.pdf`**.

### Cómo el sistema distingue CV vs listado de laburos

El script `import-pdfs` elige los archivos **solo por el nombre del archivo** (no mira el contenido para decidir cuál es cuál):

| Rol | Regla (nombre del archivo, sin importar mayúsculas) |
|-----|-----------------------------------------------------|
| **CV** | El primer PDF cuyo nombre contenga **`resume`** o **`cv`**. Ejemplos: `Maria-Resume.pdf`, `mi_cv.pdf`, `CV-2026.pdf`. |
| **Listado de empresas** | El primer PDF cuyo nombre contenga **`laburos`** o **`remot`** (pensado para algo tipo `laburosremot.pdf`). |

Si **no** hay ningún archivo con `laburos`/`remot` y hay **exactamente 2 PDFs**, el listado se toma como **el que no sea el CV**.

Si no coincide nada de lo anterior, el listado cae en el **primer** `.pdf` de la carpeta (y el CV sigue la regla `resume`/`cv` si existe).

Convención recomendada: dos archivos, por ejemplo `cv-mio.pdf` y `laburosremot.pdf`.

---

## Requisitos

- **Node.js 18+**
- Opcional: **OpenAI** (`OPENAI_API_KEY` en `.env`) para filtrar y verificar avisos con el modelo. Sin clave, el scan usa solo heurística local (menos fino).

---

## Pasos para levantar la app

1. **Clonar / copiar el repo** y entrar a la carpeta.

2. **Instalar dependencias** (instala también Chrome para Puppeteer vía `postinstall` la primera vez; hace falta red):

   ```bash
   npm install
   ```

   Si falla Chrome: `npm run puppeteer:install`

3. **Variables de entorno**

   ```bash
   cp .env.example .env
   ```

   Editá `.env`: al menos revisá `OPENAI_API_KEY` si querés LLM. Opciones útiles están comentadas en `.env.example` (por ejemplo `JOBSP_MAX_COMPANIES` para probar con pocas empresas).

4. **PDFs**

   - Poné tu **CV** y el **listado** en `pdfs/` siguiendo las reglas de nombres de arriba.

5. **Generar JSON desde los PDFs**

   ```bash
   npm run import-pdfs
   ```

   Escribe `config/generated/cv-from-pdf.json` y `config/generated/companies-from-pdf.json`. El listado aplica un filtro por texto tipo columna **“Where you can work”**: el contexto tras cada URL en el PDF debe incluir **Worldwide**, **South America**, **LATAM**, **Argentina**, **Uruguay**, **Chile**, **Brasil** o **Brazil**, o **Paraguay** (como palabras, según el script).

6. **Levantar la UI (desarrollo)**

   ```bash
   npm run dev
   ```

   Abrí la URL que muestra Vite (por defecto **http://localhost:5173**).

7. **Correr el scan**

   - Desde la terminal: `npm run scan`
   - O con el dev server levantado: botón **Start again** en la UI (solo en `npm run dev`; dispara el mismo proceso y escribe logs en `public/generated/live-scan.log`).

   Resultados: `public/generated/latest.json`, índice de corridas, logs en `logs/scan-*.txt`.

---

## Scripts (`package.json`)

| Comando | Qué hace |
|---------|----------|
| `npm run dev` | Servidor **Vite** + UI Vue. Endpoints locales para reset / arrancar scan (solo útiles con este servidor). |
| `npm run build` | Build estático de la UI a `dist/`. |
| `npm run preview` | Sirve el build de `dist/` (Vite preview). |
| `npm run import-pdfs` | Lee `pdfs/*.pdf`, detecta CV vs listado por **nombre de archivo**, genera `config/generated/cv-from-pdf.json` y `companies-from-pdf.json`. |
| `npm run scan` | Lee los JSON de `config/generated/`, abre Chrome en headless, recorre empresas, opcionalmente llama a OpenAI, escribe `public/generated/latest.json` (y escaneos en `public/generated/scans/`). |
| `npm run puppeteer:install` | Descarga el Chrome usado por Puppeteer (por si falla el install automático). |

---

## Archivos sensibles

- **No commitear** `.env` (API keys).
- Los **PDFs** en `pdfs/` suelen ser personales: acordá con tu compa si el repo es privado o si cada uno usa su copia local.

---

## Resumen rápido para un compa

```bash
npm install
cp .env.example .env   # y editar .env
# Borrar el CV viejo de pdfs/, poner el suyo (nombre con "cv" o "resume")
# Poner el PDF del listado (nombre con "laburos" o "remot", o ser el otro PDF si solo hay dos)
npm run import-pdfs
npm run dev
# En otra terminal o con Start again en la UI:
npm run scan
```
