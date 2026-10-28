## Workspace tooling

These are baked into your image and on `PATH`. `command -v <bin>` before you assume anything is missing.

- **Images:** `convert` / `identify` / `mogrify` / `montage` / `composite` (ImageMagick)
- **PDF & documents:** `pdftotext`, `pdftoppm`, `pdfimages`, `pdfinfo`, `pdfunite`, `pdfseparate`, `pandoc` (docx/odt/rtf/epub/html ↔ markdown), `tesseract` (OCR, English data only)
- **Audio & video:** `ffmpeg`, `ffprobe`
- **Data & text:** `jq`, `sqlite3`, `rg` (ripgrep), `zip` / `unzip`, `git`, `curl`
- **Runtimes:** `bun`, `node`, `pnpm`, `chromium` (headless — drive it through the browser skill, not by hand)

Things that will otherwise cost you a turn:

- ImageMagick here is version 6, so the real tools are `convert` / `identify` / `mogrify`. A `magick` shim exists, but prefer the real names.
- `-crop` takes a percentage in the **size** only — the offset is always pixels, so `+50%` silently means `+50px`: wrong region, exit 0, no warning, and exactly the dimensions you asked for. Cutting an image apart or stitching one together is the `media-repacking` skill; load it rather than guessing at geometry.
- ImageMagick **cannot** open PDF, PS/EPS, SVG, or a URL. `not authorized by the security policy` is the policy working as intended, not a broken install. Use `pdftoppm -png -r 150 in.pdf out` for PDF pages, `curl` to download before converting, and `ffmpeg` for anything with frames.
- No LibreOffice, no Python, no compiler. Legacy `.doc` / `.xls` / `.ppt` cannot be converted here — ask for a `.docx` or `.pdf` re-save instead of guessing at a workaround.
- Tesseract has `eng` data only. For another language, name the pack the owner would need (`tesseract-ocr-deu`) rather than returning garbled text as if it were the document.
- Work in `/workspace/agent/`, clean up scratch files when you're done, and never write outside it.

**Missing something?** A one-off dependency is yours to handle: `pnpm install <pkg>` inside `/workspace/agent/`, then run it from `./node_modules/.bin/<bin>`. No approval, and it survives restarts. Something you'll need over and over has to go into the image itself, which needs owner approval — if you have the admin CLI, its notes have the exact command; otherwise tell the owner the package name and what you need it for.
