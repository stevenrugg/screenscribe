import { NextRequest } from 'next/server';
import { runPipeline, PipelineEvent } from '@/lib/pipeline';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300; // hint to platforms; in self-hosted Node this is unbounded

/**
 * Server-Sent Events stream.
 *
 * Query params (sent via GET so we can use EventSource on the client):
 *   streamUrl  - the resolved audio/video stream URL
 *   target     - target language code (e.g. "en", "es")
 *   chunk      - chunk seconds (default 30)
 *
 * Emits one `data: {json}\n\n` per pipeline event.
 */
export async function GET(req: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return new Response('OPENAI_API_KEY not configured on server', { status: 500 });
  }

  const sp = req.nextUrl.searchParams;
  const streamUrl = sp.get('streamUrl');
  const target = sp.get('target') ?? 'en';
  const chunk = Math.max(10, Math.min(120, parseInt(sp.get('chunk') ?? '30', 10) || 30));

  if (!streamUrl) {
    return new Response('streamUrl is required', { status: 400 });
  }

  const encoder = new TextEncoder();
  const abortCtl = new AbortController();

  // Forward client disconnect to the pipeline
  req.signal.addEventListener('abort', () => abortCtl.abort());

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: PipelineEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`));
        } catch {
          // controller already closed
        }
      };

      // Heartbeat keeps proxies from timing out idle connections
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {}
      }, 15_000);

      try {
        for await (const ev of runPipeline({
          streamUrl,
          targetLanguageCode: target,
          chunkSeconds: chunk,
          signal: abortCtl.signal,
          openaiApiKey: apiKey,
        })) {
          send(ev);
          if (ev.type === 'done') break;
        }
      } catch (err) {
        send({
          type: 'error',
          message: err instanceof Error ? err.message : 'Pipeline error',
        });
      } finally {
        clearInterval(heartbeat);
        try { controller.close(); } catch {}
      }
    },
    cancel() {
      abortCtl.abort();
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering when behind one
    },
  });
}
