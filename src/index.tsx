import { readFile } from "fs/promises";
import { createServer, STATUS_CODES } from "http";
import { Suspense } from "solid-js";
import { HydrationScript, renderToStringAsync } from "solid-js/web";
import { errorRoutes, match } from "~/components/Router";
import Router from "~/components/Router.client";

createServer(async (req, res) => {
  try {
    const url = req.url;

    if (url === undefined || url[0] !== "/" || url.includes("?")) {
      res.writeHead(404).end();
      return;
    }

    if (url.endsWith(".js")) {
      const data = await readFile("dist/client" + url);
      res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" }).end(data);
      return;
    }

    if (url.endsWith(".css")) {
      const data = await readFile("dist/client" + url);
      res.writeHead(200, { "content-type": "text/css" }).end(data);
      return;
    }

    const _url = new URL(url, "http://127.0.0.1:3000/");
    const matches = match(_url);

    if (matches) {
      const [head, body] = await Promise.all([
        renderToStringAsync(matches.Router),
        renderToStringAsync(() => (
          <>
            <Router url={_url}></Router>
            <HydrationScript></HydrationScript>
          </>
        )),
      ]);

      // "</div></body></html>".length === 20
      const html = `<!DOCTYPE html>${head.slice(0, -20)}${body}${head.slice(-20)}`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
      return;
    }

    res.writeHead(404).end(`404 ${STATUS_CODES[404]}`);
    return;
  } catch (err) {
    try {
      if (typeof err === "number") {
        const Route = errorRoutes[err];

        if (Route) {
          const html = await renderToStringAsync(() => (
            <Suspense>
              <Route></Route>
            </Suspense>
          ));

          res.writeHead(err, { "content-type": "text/html; charset=utf-8" }).end(html);
          return;
        }
      }
    } catch {}
  }

  try {
    const Route = errorRoutes[500];

    if (Route) {
      const html = await renderToStringAsync(() => (
        <Suspense>
          <Route></Route>
        </Suspense>
      ));

      res.writeHead(500, { "content-type": "text/html; charset=utf-8" }).end(html);
      return;
    }
  } catch {}

  res.writeHead(500).end(`500 ${STATUS_CODES[500]}`);
}).listen(3000);
