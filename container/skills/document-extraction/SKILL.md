---
name: document-extraction
description: How to get readable text out of a PDF, Word/OpenDocument file, or scanned image that is not already in memory. Use when a task references a .pdf, .docx, .odt, .rtf, .epub, .html, or an image of a document — and especially when `extract_document` came back empty, or the file is a legacy .doc/.xls/.ppt or in a language English OCR cannot read. A document already filed in memory needs none of this: its text was read on arrival, and `memory_read {document}` gives it back.
---

# Document Extraction

**Files the user attached are already extracted.** The runtime reads every inbound
attachment before your turn starts and puts the text in an `<attachments>` block,
tagged with which tool read it. Read that block. Do not shell out to `pdftotext`
or `tesseract` for a file that is already sitting there extracted — it costs a
round-trip and produces the same bytes.

**A document already in memory is already extracted too.** A file filed with
`memory_ingest` was read when it arrived — its text layer, or OCR when it had
none — and the whole of that text is kept. `memory_read {document: "<id>"}`
returns it, with no extraction and no OCR. The id is `documents[].id` in a
`memory_read {slug}`, and it is on every recall card that quotes the file. The
short page beside a stored document describes it; it is not the document.

## Everything else: `extract_document`

```
extract_document { path: "/workspace/agent/downloads/contract.pdf" }
```

Use it when:

- the `<attachments>` entry says the text was **clipped** and you need the rest
- the file is one you **downloaded or generated** yourself

Container paths only. The knowledge base is not mounted here, so no path and no
id reaches a stored file from this tool — that is `memory_read`'s job.

It returns the extracted text plus the path to a `.txt` holding the complete
verbatim content, which is what you want when the result was clipped and you
need to search or quote the rest. A scanned PDF with no text layer is rendered
to page images and shown to you instead.

On an image, `extract_document` also **shows** you the picture alongside the OCR text —
so it is how you check a file you made yourself, not just one you were sent. To cut an
image apart or stitch one together in the first place, load the `media-repacking` skill.

## Escape hatch: the raw CLI tools

Only for what `extract_document` cannot do. Work in `/workspace/agent/` and clean
up your scratch files afterwards.

**Legacy binary Office formats** are not covered — no LibreOffice in this image.
Ask the user to re-save as `.docx` / `.pdf`:

```bash
pandoc input.docx -t markdown -o out.md   # .docx .odt .rtf .html .epub only
```

**A language English OCR cannot read.** Only `eng` tesseract data is installed.
Tell the user which pack would be needed (`tesseract-ocr-<lang>`) rather than
returning garbled text as if it were the document:

```bash
tesseract scan.png stdout -l eng
```

**Embedded images or per-page control**, which the tool does not expose:

```bash
pdfinfo input.pdf                     # page count, metadata
pdfimages -all input.pdf imgpref      # extract embedded images
pdftoppm -r 300 -png -f 3 -l 3 input.pdf page   # rasterize one page at 300dpi
```

## After extracting

Work from the text like any other input: summarize, answer, pull structured data.

**To keep the document, give the file to `memory_ingest {path, folder}` — not your text.**
Choose the destination from memory's structure and the conversation; do not ask the user where it goes.
Ingest reads it again itself, names it from what is inside, summarizes it, and
files it beside a page it writes; the text it extracts is what `memory_read
{document}` hands back later. Pasting your own extraction into a page stores a
copy that cannot be corrected when the file changes, and leaves the bytes
nowhere.
