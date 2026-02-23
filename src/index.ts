const port = Number(process.env.PORT) || 3000;
const hostname = "0.0.0.0";

const server = Bun.serve({
  port,
  hostname,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        app: "tweety",
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    }

    if (url.pathname === "/") {
      return new Response(
        `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tweety — Kapable Canary</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #0a0a0a;
      color: #e5e5e5;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .container {
      text-align: center;
      max-width: 480px;
      padding: 2rem;
    }
    h1 { font-size: 2.5rem; margin-bottom: 0.5rem; }
    .canary { color: #fbbf24; font-size: 3rem; margin-bottom: 1rem; }
    .status { color: #4ade80; font-size: 0.9rem; margin-top: 1rem; }
    .meta { color: #737373; font-size: 0.8rem; margin-top: 2rem; }
    a { color: #60a5fa; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="canary">&#x1F426;</div>
    <h1>Tweety</h1>
    <p>Kapable platform canary app</p>
    <p class="status">Status: healthy</p>
    <p class="meta">
      Bun ${Bun.version} &middot;
      <a href="/health">/health</a>
    </p>
  </div>
</body>
</html>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});

console.log(`Tweety canary running on ${hostname}:${port}`);
