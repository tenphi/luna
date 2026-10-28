---
name: media-repacking
description: How to split, crop, merge, rotate, or repack images and PDFs — and how to prove the result is what you think it is before you store it or send it. Use when a task means cutting one photo into several, combining scans into one file, making a separate image for each document in a shared one, building a composite, deskewing, or rotating — especially when which region you cut decides which document each piece holds.
---

# Media Repacking

Cutting an image apart is the one operation where a command that **succeeds** still
gives you the wrong answer, and nothing downstream will tell you. Geometry bugs do
not raise errors — they produce a file of exactly the right size holding exactly the
wrong content, and every later step (the label you write, the page you file it on,
what you tell the user) inherits that mistake silently.

So the rule here is not about the commands. It is: **you have not verified a file you
made until you have read it back.**

## Splitting: prefer tiles over arithmetic

`-crop` with an `@` tiles the image into equal pieces and needs no numbers from you:

```bash
convert in.jpg -crop 2x1@ +repage out-%d.jpg   # out-0.jpg = left, out-1.jpg = right
convert in.jpg -crop 1x2@ +repage out-%d.jpg   # out-0.jpg = top,  out-1.jpg = bottom
```

That is what you want for "two cards side by side", "front and back stacked", and
most of what people photograph. Use it whenever the pieces are equal.

### The percentage-offset trap

When you do need explicit geometry, offsets are **pixels — always**. A percentage is
honoured in the *size* and silently ignored in the *offset*:

```bash
convert in.jpg -crop 50%x100%+50%+0 +repage right.jpg   # WRONG: +50% means +50px
```

On a 1200px-wide image that asks for the right half and gives you a 600px crop of the
**left** half, nudged 50px over, with a sliver of the right-hand subject at the edge.
Exit code 0. No warning. Correct dimensions. If you had two of these, both "halves"
would be the same subject.

Read the real size first and pass pixels:

```bash
identify -format '%wx%h\n' in.jpg          # 1200x400
convert in.jpg -crop 600x400+600+0 +repage right.jpg
```

## Stitching back together

```bash
montage front.jpg back.jpg -tile 1x2 -geometry +0+12 combined.jpg   # stacked
convert front.jpg back.jpg -append combined.jpg                     # no padding
convert page1.png page2.png combined.pdf                            # images → PDF
pdfunite a.pdf b.pdf combined.pdf                                   # PDFs → PDF
```

## Then verify — before you store, send, or name it

`identify` checks **geometry, not content**. The wrong half of an image has precisely
the right width, so dimensions matching what you asked for proves nothing.

To actually check content:

```
extract_document { path: "/workspace/agent/out-1.jpg" }
```

It OCRs the file **and** shows you the image. Do this for every piece whose identity
matters, and compare them against each other — two crops that should show two
different documents, both reading back the same text, is the tell you would otherwise
miss entirely.

Three things that are **not** verification:

- **The filename you chose.** You named it `ada-front.jpg` because of the order you
  cut it in, not because of what is in it. It is a hypothesis, not a fact.
- **An exit code of 0.** See the trap above.
- **Metadata you wrote earlier in the turn.** Correct text on a page says nothing
  about which bytes are attached to it.

## Filing and sending

A file you generated is worth storing when producing and keeping it is what was asked
for — a scan split into its separate documents, pages merged into one PDF. When it is:

- Store each verified piece with `memory_ingest {path, folder}`. Ingest reads the file
  again, names it from what is inside, and files it beside a page it writes.
- **Any label or page text you write comes from what you read in that file**, not from
  the order you cut the pieces. The label is a claim about the bytes; make it one you
  have checked.
- Sending is `send_file` — `path` for a piece still in `/workspace/agent/`, `memory` for
  one already stored. Verify before sending, not after — a wrong document going out
  is worse than a slow one.

## If the result comes back wrong

**The command is the suspect. Change it, don't re-run it.** Re-running geometry that
produced the wrong region reproduces the wrong region — byte for byte, and the second
identical output looks like confirmation when it is just the same bug.

Work the problem in this order:

1. `identify` both the source and the output. Confirm which region you actually took.
2. Read what you stored — `memory_read {document: "<id>"}` returns the text memory read
   from it on arrival. Take the id from `documents[].id` in a `memory_read {slug}`, since
   bare filenames can collide across pages.
3. Re-cut with tiles or explicit pixel offsets, and read the new pieces back.
4. Drop the wrong stored file with `memory_forget {document: "<id>"}`, then
   `memory_ingest` the corrected piece. Never ingest the fix on top — that leaves the
   wrong file stored beside the right one.

If a fetch or a conversion fails, say so. Do not describe an image you were not shown.
