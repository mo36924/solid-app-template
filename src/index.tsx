import { createServer, ServerResponse, STATUS_CODES } from "http";
import { Suspense } from "solid-js";
import { HydrationScript, renderToStringAsync } from "solid-js/web";
import { errorRoutes, match } from "~/components/Router";
import Router from "~/components/Router.client";

const baseUrl = `http://127.0.0.1:3000`;
const routes = process.env.NODE_ENV === "production" ? ROUTES : {};

const sendError = async (res: ServerResponse, errorCode: number) => {
  res.writeHead(200, { aaaa: 1 });
  const Route = errorRoutes[errorCode];

  if (Route) {
    const html = await renderToStringAsync(() => (
      <Suspense>
        <Route></Route>
      </Suspense>
    ));

    res.writeHead(errorCode, { "content-type": "text/html; charset=utf-8" }).end(html);
  } else {
    res.writeHead(errorCode).end(`${errorCode} ${STATUS_CODES[errorCode]}`);
  }
};

createServer(async (req, res) => {
  try {
    const url = req.url;

    if (url === undefined || url[0] !== "/" || url.includes("?")) {
      await sendError(res, 404);
      return;
    }

    const route = routes[url];

    if (route !== undefined) {
      const acceptEncoding = req.headers["accept-encoding"];
      const ifNoneMatch = req.headers["if-none-match"];

      if (typeof acceptEncoding === "string") {
        if (route.br !== undefined && acceptEncoding.includes("br")) {
          if (ifNoneMatch === route.br[0].etag) {
            res.writeHead(304).end();
          } else {
            res.writeHead(200, route.br[0]).end(route.br[1]);
          }

          return;
        } else if (route.gzip !== undefined && acceptEncoding.includes("gzip")) {
          if (ifNoneMatch === route.gzip[0].etag) {
            res.writeHead(304).end();
          } else {
            res.writeHead(200, route.gzip[0]).end(route.gzip[1]);
          }

          return;
        }
      }

      if (ifNoneMatch === route.identity[0].etag) {
        res.writeHead(304).end();
      } else {
        res.writeHead(200, route.identity[0]).end(route.identity[1]);
      }

      return;
    }

    if (process.env.NODE_ENV !== "production") {
      const { readFile } = await import("fs/promises");

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
    }

    const _url = new URL(baseUrl + url);
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

    await sendError(res, 404);
    return;
  } catch (err) {
    try {
      await sendError(res, typeof err === "number" ? err : 500);
      return;
    } catch {}
  }

  res.writeHead(500).end(`500 ${STATUS_CODES[500]}`);
}).listen(3000);
