import { NextRequest, NextResponse } from 'next/server';
import { discoverStreams } from '@/lib/discover';

// Long-running yt-dlp call; we don't want this on the edge
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const url = body.url?.trim();
  if (!url) {
    return NextResponse.json({ error: 'url is required' }, { status: 400 });
  }

  try {
    const streams = await discoverStreams(url);
    return NextResponse.json({ streams });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Discovery failed' },
      { status: 400 }
    );
  }
}
