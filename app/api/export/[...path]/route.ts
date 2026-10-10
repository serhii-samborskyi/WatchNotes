// The local Node process owns FFmpeg. This route keeps the browser on one origin
// in production; the Vite proxy provides the same contract during development.
async function proxy(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const headers = new Headers();
  for (const name of ['content-type', 'x-export-token', 'origin']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  try {
    const upstream = await fetch(
      `http://127.0.0.1:4311/api/export/${path.map(encodeURIComponent).join('/')}`,
      {
        method: request.method,
        headers,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
        signal: request.signal,
      },
    );
    const output = new Headers();
    for (const name of ['content-type', 'content-disposition', 'cache-control']) {
      const value = upstream.headers.get(name);
      if (value) output.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: output });
  } catch {
    return Response.json(
      { error: 'The video export service is not running. Start the app with npm run dev.' },
      { status: 503 },
    );
  }
}
export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
