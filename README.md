# StreamScribe

Paste a URL → discover audio/video streams → live-transcribe and translate to any of 20 target languages → download `.txt` and `.srt`.

Next.js 14 (App Router, TypeScript) · ffmpeg · OpenAI Whisper · gpt-4o-mini · Server-Sent Events.

## What it does

1. **You paste a URL.** Page URL (e.g. `iranintl.com`), YouTube live, Twitch, raw `.m3u8`/`.mpd` — anything goes.
2. **`/api/discover` finds the streams.** Strategy:
   - If the URL is itself a manifest (`.m3u8`/`.mpd`), use it directly.
   - Otherwise, fetch the page and scan the HTML for embedded manifest URLs.
   - If still nothing, hand it to `yt-dlp` for YouTube/Twitch/Vimeo/etc.
3. **You pick a target language and a stream.**
4. **`/api/transcribe` opens an SSE connection** and runs the pipeline:
   - `ffmpeg` segments live audio into 30-second mono 16 kHz MP3 chunks.
   - Each chunk → Whisper (`/v1/audio/transcriptions`, `verbose_json`) for source-language text + detected language.
   - If detected language ≠ target, source text → `gpt-4o-mini` for translation.
   - Each `chunk` event streams back to the browser and renders live.
5. **Download** as `.txt` (with timestamps and source/target side-by-side) or `.srt` (subtitle format with proper cue timing).

## Requirements

- Node.js 18.18+
- `ffmpeg` on `$PATH`
- `yt-dlp` on `$PATH` (optional but recommended — enables YouTube/Twitch/etc.)
- An OpenAI API key with Whisper + Chat Completions access

## Setup

```bash
cp .env.example .env.local
# edit .env.local and set OPENAI_API_KEY=sk-...

npm install
npm run dev
```

Visit http://localhost:3000.

## Architecture

```
┌─────────────┐   POST /api/discover   ┌─────────────────────┐
│   Browser   │ ────────────────────▶  │  discover.ts        │
│             │                        │  • HTML scan        │
│             │ ◀───── streams[] ────  │  • yt-dlp fallback  │
│             │                        └─────────────────────┘
│             │
│             │   GET /api/transcribe (EventSource / SSE)
│             │ ────────────────────────────────────────────┐
│             │                                              ▼
│             │                          ┌──────────────────────────────┐
│             │   data: {chunk}          │  pipeline.ts (async gen)      │
│             │ ◀─────────────────────── │  ┌─────────┐  ┌────────────┐ │
│             │                          │  │ ffmpeg  │→ │  Whisper   │ │
│             │                          │  │ segment │  └─────┬──────┘ │
│             │                          │  └─────────┘        │        │
│             │                          │                     ▼        │
│             │                          │              ┌──────────────┐│
│             │                          │              │ gpt-4o-mini  ││
│             │                          │              │ (translate)  ││
│             │                          │              └──────────────┘│
└─────────────┘                          └──────────────────────────────┘
```

## Why this shape

- **No DB.** Per requirements — all session state lives in browser memory until you download. Restarts wipe it. (Adding Prisma + Postgres later is a ~50-line change in `pipeline.ts` and `page.tsx`.)
- **SSE, not WebSockets.** Server → client only; no need for two-way. SSE auto-reconnects and survives most proxies if you set `X-Accel-Buffering: no` (we do).
- **Whisper transcribe + LLM translate** instead of Whisper's `/translations` endpoint. The `/translations` endpoint only outputs English; transcribe-then-translate works for any of 100+ source languages → 20 target languages.
- **Chunk N is finalized when N+1 starts.** ffmpeg's `-f segment` doesn't tell us when a chunk is "done"; checking for the next chunk's existence is the simplest reliable signal.

## Limits & caveats

- **Whisper hallucinations on silence.** If a chunk is mostly silence or music intro, Whisper sometimes invents a phrase ("Thanks for watching!" is a famous one). Lower chunk size or post-filter if it bothers you.
- **Latency.** ~30 s buffering + ~2-5 s API round-trip = first chunk lands ~35 s after Start. Tunable via the `chunk` query param.
- **Cost.** Whisper is $0.006/min. Translation adds ~$0.0001 per chunk on `gpt-4o-mini`. A 1-hour session ≈ $0.36 + change.
- **No DB** means refreshing the browser ends the session.
- **YouTube live/etc.** depends on yt-dlp being installed and current. Update with `pip install -U yt-dlp` if extraction breaks.

## File map

```
src/
├── app/
│   ├── api/
│   │   ├── discover/route.ts    # POST: scan a URL for streams
│   │   └── transcribe/route.ts  # GET (SSE): live pipeline
│   ├── globals.css               # editorial palette + grain
│   ├── layout.tsx
│   └── page.tsx                  # the whole UI
└── lib/
    ├── discover.ts               # HTML scan + yt-dlp wrapper
    ├── languages.ts              # 20-language target list
    ├── pipeline.ts               # ffmpeg → Whisper → gpt-4o-mini, async generator
    └── transcript.ts             # .txt and .srt formatters
```
