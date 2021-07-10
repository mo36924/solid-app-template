import { parseAsync, PluginItem, PluginObj, traverse, types as t } from "@babel/core";
import jsx from "@babel/plugin-syntax-jsx";
import syntaxTypescript from "@babel/plugin-syntax-typescript";
import env from "@babel/preset-env";
import typescript from "@babel/preset-typescript";
import { gzipAsync } from "@gfx/zopfli";
import alias from "@rollup/plugin-alias";
import { babel } from "@rollup/plugin-babel";
import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import nodeResolve from "@rollup/plugin-node-resolve";
import replace from "@rollup/plugin-replace";
import solid from "babel-preset-solid";
import { pascalCase } from "change-case";
import { watch } from "chokidar";
import { createHash } from "crypto";
import { ESLint } from "eslint";
import { once } from "events";
import glob from "fast-glob";
import { mkdir, readFile, writeFile } from "fs/promises";
import { builtinModules } from "module";
import { dirname, extname, relative, resolve, sep } from "path";
import { chromium } from "playwright";
import type { AcceptedPlugin } from "postcss";
import postcss, { Plugin as PostcssPlugin } from "postcss";
import postcssrc, { ResultPlugin } from "postcss-load-config";
import valueParser from "postcss-value-parser";
import prettier from "prettier";
import type { Plugin as RollupPlugin, RollupOptions } from "rollup";
import { terser } from "rollup-plugin-terser";
import subsetFont from "subset-font";
import { pathToFileURL } from "url";
import { Worker } from "worker_threads";
import { brotliCompressSync, constants } from "zlib";
import ts from "typescript";

type Routes = {
  [pathname: string]: {
    br?: [headers: Headers, data: Buffer];
    gzip?: [headers: Headers, data: Buffer];
    identity: [headers: Headers, data: Buffer];
  };
};

type Headers = {
  "cache-control": string;
  "content-encoding": "br" | "gzip" | "identity";
  "content-length": string;
  "content-type"?: string;
  etag: string;
};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV?: "production" | "development" | "test";
      PORT?: number;
    }
  }
  const URL_JS: string | undefined;
  const URL_CSS: string | undefined;
  const ROUTES: {
    [pathname: string]: {
      br?: [headers: Headers, data: Buffer];
      gzip?: [headers: Headers, data: Buffer];
      identity: [headers: Headers, data: Buffer];
    };
  };
}

const prod = process.env.NODE_ENV === "production";
const eslint = new ESLint({ extensions: [".ts", ".tsx"], fix: true });

const formatDiagnosticsHost: ts.FormatDiagnosticsHost = {
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getCanonicalFileName: (fileName) => fileName,
  getNewLine: () => ts.sys.newLine,
};

async function write(path: string, data: string, format?: boolean) {
  if (format) {
    const result = await eslint.lintText(data, { filePath: path });
    data = result[0].output ?? data;
    const config = await prettier.resolveConfig(path);
    data = prettier.format(data, { ...config, filepath: path });
  }

  try {
    await writeFile(path, data);
  } catch {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }
}

async function routeGenerator(options: {
  file: string;
  dir: string;
  include: string;
  exclude?: string;
  lazy?: boolean;
}) {
  const { file, dir, include, exclude, lazy } = options;
  const tsconfig = await readFile("tsconfig.json", "utf-8");
  const { compilerOptions } = JSON.parse(tsconfig);
  const jsxImportSource = compilerOptions.jsxImportSource ?? "solid-js";
  const jsxRuntime = `${jsxImportSource}/jsx-runtime`;
  const routeDir = resolve(dir);
  const router = resolve(file);
  const routerDir = dirname(router);
  const normalize = (path: string) => path.split(sep).join("/");

  const pathToRoute = (path: string) => {
    const nonExtPath = path.slice(0, -extname(path).length);
    const routePath = normalize(relative(routeDir, nonExtPath.slice(0, -extname(nonExtPath).length || undefined)));

    const routeName = pascalCase(routePath)
      .replace(/[^A-Za-z0-9_$]/g, "")
      .replace(/^[^A-Za-z_$]/, "_$&");

    let pagePath =
      "/" +
      routePath
        .replace(/^index$/, "")
        .replace(/\/index$/, "/")
        .replace(/__|_/g, (m) => (m === "_" ? ":" : "_"));

    const rank = pagePath
      .split("/")
      .map((segment) => {
        if (!segment.includes(":")) {
          return 9;
        }

        if (segment[0] !== ":") {
          return 8;
        }

        return segment.split(":").length;
      })
      .join("");

    const isDynamic = pagePath.includes(":");
    const paramNames: string[] = [];

    if (isDynamic) {
      pagePath =
        "/^" +
        pagePath.replace(/\//g, "\\/").replace(/\:([A-Za-z][0-9A-Za-z]*)/g, (_m, p1) => {
          paramNames.push(p1);
          return "([^\\/]+?)";
        }) +
        "$/";
    }

    const propsType = paramNames.length ? `{${paramNames.map((name) => `${name}: string`).join()}}` : "any";

    let importPath = normalize(relative(routerDir, nonExtPath));

    if (importPath[0] !== "." && importPath[0] !== "/") {
      importPath = `./${importPath}`;
    }

    return {
      routeName,
      importPath,
      isDynamic,
      pagePath,
      paramNames,
      propsType,
      rank,
    };
  };

  const watcher = watch(include, { cwd: routeDir, ignored: exclude });

  const generateDefaultFile = async (path: string) => {
    path = resolve(routeDir, path);
    let code = await readFile(path, "utf-8");

    if (code.trim() !== "") {
      return;
    }

    const { isDynamic, propsType } = pathToRoute(path);

    if (isDynamic) {
      code = `
        export default (props: ${propsType}) => {
          return (
            <div></div>
          )
        }
      `;
    } else {
      code = `
        export default () => {
          return (
            <div></div>
          )
        }
      `;
    }

    await write(path, code, true);
  };

  const generate = async () => {
    const routes = Object.entries(watcher.getWatched())
      .flatMap(([dir, names]) => names.map((name) => pathToRoute(resolve(routeDir, dir, name))))
      .sort((a, b) => (b.rank as any) - (a.rank as any));

    const imports: string[] = [`import type { JSX } from "${jsxRuntime}"`];

    const type = lazy
      ? `type Route<T = (props?: any) => JSX.Element> = T & {
          preload: (props?: any) => Promise<T>
        }`
      : `type Route<T = (props?: any) => JSX.Element> = T`;

    const staticRoutes: string[] = [];
    const dynamicRoutes: string[] = [];
    const errorRoutes: string[] = [];

    const jsx = `<Suspense><Route {...props} /></Suspense>`;

    if (lazy) {
      imports.push(`import { lazy, Suspense } from "${jsxImportSource}"`);
    } else {
      imports.push(`import { Suspense } from "${jsxImportSource}"`);
    }

    for (const { routeName, importPath, pagePath, isDynamic, paramNames, propsType } of routes) {
      if (lazy) {
        imports.push(`const ${routeName} = lazy(() => import("${importPath}"))`);
      } else {
        imports.push(`import ${routeName} from "${importPath}"`);
      }

      if (isDynamic) {
        dynamicRoutes.push(
          `[${pagePath}, ${JSON.stringify(paramNames)}, ${routeName} as Route<(props: ${propsType}) => JSX.Element>]`,
        );
      } else if (/^\/[45]\d\d$/.test(pagePath)) {
        errorRoutes.push(`${pagePath.slice(1)}: ${routeName} as Route`);
      } else {
        staticRoutes.push(`"${pagePath}": ${routeName} as Route`);
      }
    }

    const code = `
      ${imports.join("\n")}

      ${type}

      export const staticRoutes: { [pathname: string]: Route | undefined } = {
        ${staticRoutes.join()}
      };

      export const dynamicRoutes: [RegExp, string[], Route][] = [
        ${dynamicRoutes.join()}
      ];

      export const errorRoutes: { [pathname: string]: Route | undefined } = {
        ${errorRoutes.join()}
      };

      export const match = (url: URL) => {
        const pathname = url.pathname;
        const props: { [name: string]: string } = {};
        let Route = staticRoutes[pathname]!;
      
        if (!Route) {
          dynamicRoutes.some((dynamicRoute) => {
            const matches = pathname.match(dynamicRoute[0]);
      
            if (matches) {
              dynamicRoute[1].forEach((name, index) => (props[name] = matches[index + 1]));
              Route = dynamicRoute[2];
              return true;
            }
          });
        }
      
        return (Route as Route | undefined) && { Route, props, Router: () => ${jsx} };
      }
      
      export default (props: { url: URL }) => {
        const matches = match(props.url);
        return matches && <matches.Router />;
      }
    `;

    await write(router, code, true);
  };

  await once(watcher, "ready");
  await generate();

  if (prod) {
    await watcher.close();
  } else {
    watcher
      .on("add", generateDefaultFile)
      .on("change", generateDefaultFile)
      .on("add", generate)
      .on("addDir", generate)
      .on("unlink", generate)
      .on("unlinkDir", generate);
  }
}

export default async (): Promise<RollupOptions[]> => {
  await Promise.all([
    routeGenerator({
      file: "src/components/Router.tsx",
      dir: "src/routes",
      include: "**/*.tsx",
      exclude: "**/*.client.tsx",
    }),
    routeGenerator({
      file: "src/components/Router.client.tsx",
      dir: "src/routes",
      include: "**/*.client.tsx",
      lazy: true,
    }),
  ]);

  const program = ts.createWatchProgram(
    ts.createWatchCompilerHost(
      "tsconfig.json",
      { noEmit: true },
      ts.sys,
      ts.createEmitAndSemanticDiagnosticsBuilderProgram,
      (diagnostic) => ts.sys.write(ts.formatDiagnosticsWithColorAndContext([diagnostic], formatDiagnosticsHost)),
      (diagnostic, _newLine, _options, errorCount) => {
        ts.sys.write(ts.formatDiagnosticsWithColorAndContext([diagnostic], formatDiagnosticsHost));
        process.exitCode = errorCount || 0;
      },
    ),
  );

  if (prod) {
    program.close();

    if (process.exitCode) {
      process.exit();
    }
  }

  const globalDefs: { [define: string]: string | undefined } = { "process.env.NODE_ENV": process.env.NODE_ENV };
  const clientRollupPlugins: RollupPlugin[] = [];
  const serverRollupPlugins: RollupPlugin[] = [];
  const babelPlugins: PluginItem[] = [];
  const postcssPlugins: AcceptedPlugin[] = [];
  const routes: Routes = {};

  // material icons
  if (prod) {
    const data = await readFile("node_modules/material-design-icons/iconfont/codepoints", "utf-8");

    const materialIcons = Object.assign<{}, { [alias: string]: string | undefined }>(
      Object.create(null),
      Object.fromEntries(
        data
          .trim()
          .split("\n")
          .map((codepoint) => codepoint.split(" ")),
      ),
    );

    const codepoints = Object.assign<{}, { [codepoint: string]: string | undefined }>(
      Object.create(null),
      Object.fromEntries(Object.entries(materialIcons).map((entry) => entry.reverse())),
    );

    const babel = (): PluginObj => ({
      name: "material-icons",
      inherits: jsx.default,
      visitor: {
        Program(path, state) {
          const materialIconSet = new Set<string>();

          path.traverse({
            JSXElement({ node: { openingElement, children } }) {
              if (
                t.isJSXIdentifier(openingElement.name) &&
                openingElement.name.name === "i" &&
                children.length === 1 &&
                t.isJSXText(children[0])
              ) {
                const value = children[0].value.trim();

                if (value.startsWith("&#x")) {
                  const codepoint = value.slice(3);
                  const alias = codepoints[codepoint];

                  if (alias) {
                    materialIconSet.add(codepoint);
                  }
                } else {
                  const codepoint = materialIcons[value];

                  if (codepoint) {
                    const value = `&#x${codepoint}`;
                    children[0] = t.jsxText(value);
                    children[0].extra = { raw: value, rawValue: value };
                    materialIconSet.add(codepoint);
                  }
                }
              }
            },
          });

          (state.file.metadata as any).materialIcons = [...materialIconSet].sort();
        },
      },
    });

    const materialIconSet = new Set<string>();
    const paths = await glob("src/**/*.tsx");

    await Promise.all(
      paths.map(async (path) => {
        const data = await readFile(path, "utf-8");
        const result = await parseAsync(data, { plugins: [[syntaxTypescript, { isTSX: true }], jsx] });

        traverse(result, {
          JSXElement({ node: { openingElement, children } }) {
            if (
              t.isJSXIdentifier(openingElement.name) &&
              openingElement.name.name === "i" &&
              children.length === 1 &&
              t.isJSXText(children[0])
            ) {
              const value = children[0].value.trim();

              if (value.startsWith("&#x")) {
                const codepoint = value.slice(3);
                const alias = codepoints[codepoint];

                if (alias) {
                  materialIconSet.add(codepoint);
                }
              } else {
                const codepoint = materialIcons[value];

                if (codepoint) {
                  materialIconSet.add(codepoint);
                }
              }
            }
          },
        });
      }),
    );

    const path = "node_modules/material-design-icons/iconfont/MaterialIcons-Regular.woff2";
    const fileUrl = pathToFileURL(path).href;
    const woff2 = await readFile(path);
    const dataUrl = `data:font/woff2;base64,${woff2.toString("base64")}`;
    const subsetCodepoints = [...materialIconSet].sort().map((materialIcon) => parseInt(materialIcon, 16));
    const subset = await subsetFont(woff2, String.fromCodePoint(...subsetCodepoints), { targetFormat: "woff2" });
    const subsetDataUrl = `data:font/woff2;base64,${subset.toString("base64")}`;

    const postcss: PostcssPlugin = {
      postcssPlugin: "material-icons",
      Declaration: {
        src(decl, helper) {
          const base = pathToFileURL(helper.result.opts.from ?? ".");
          const value = valueParser(decl.value);

          for (const node of value.nodes) {
            if (node.type === "function" && node.value === "url") {
              for (const _node of node.nodes) {
                if (_node.type === "word" || _node.type === "string") {
                  const url = new URL(_node.value, base).href;

                  if (url === fileUrl || url === dataUrl) {
                    _node.value = subsetDataUrl;
                  }
                }
              }
            }
          }

          decl.value = value.toString();
        },
      },
    };

    babelPlugins.push(babel);
    postcssPlugins.push(postcss);
  }

  // generate css
  {
    const input = "src/index.css";
    let plugins: ResultPlugin[] = [];
    let options: { from?: string } = { from: input };

    try {
      const result = await postcssrc(options);
      plugins = result.plugins;
      options = result.options;
    } catch {}

    const data = await readFile(input, "utf-8");
    const result = await postcss(...plugins, ...postcssPlugins).process(data, options);
    const name = prod ? createHash("sha256").update(result.css).digest("hex").slice(0, 8) : "index";
    const fileName = `${name}.css`;
    const url = `/${fileName}`;
    const output = `dist/client${url}`;
    const css = `/*! Material design icons | Apache License 2.0 | https://github.com/google/material-design-icons */\n${result.css}`;
    await write(output, css);
    globalDefs.URL_CSS = url;

    if (prod) {
      clientRollupPlugins.push({
        name: "asset-css",
        buildStart() {
          this.emitFile({ type: "asset", fileName, name: fileName, source: css });
        },
      });
    }
  }

  // rollup plugins
  if (prod) {
    clientRollupPlugins.push({
      name: "define",
      async generateBundle(_options, bundle) {
        const values = Object.values(bundle);
        const entryFileName = values.find((v) => v.type === "chunk" && v.isEntry)!.fileName;
        const url = `/${entryFileName}`;
        globalDefs.URL_JS = url;

        for (const value of values) {
          const source = value.type === "chunk" ? value.code : value.source;
          const isText = typeof source === "string";
          const pathname = `/${value.fileName}`;
          const identity = Buffer.from(source);
          const cacheControl = "public, max-age=86400";
          let contentType = "application/javascript; charset=utf-8";

          switch (extname(value.fileName)) {
            case ".css":
              contentType = "text/css";
              break;
          }

          const identityHeaders: Headers = {
            "cache-control": cacheControl,
            "content-encoding": "identity",
            "content-length": identity.length.toFixed(),
            "content-type": contentType,
            etag: `W/"${createHash("md5").update(identity).digest("hex")}"`,
          };

          if (!isText) {
            routes[pathname] = {
              identity: [identityHeaders, identity],
            };

            continue;
          }

          const br = brotliCompressSync(identity, {
            params: {
              [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
              [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
              [constants.BROTLI_PARAM_SIZE_HINT]: identity.length,
            },
          });

          const brHeaders: Headers = {
            "cache-control": cacheControl,
            "content-encoding": "br",
            "content-length": br.length.toFixed(),
            "content-type": contentType,
            etag: `W/"${createHash("md5").update(br).digest("hex")}"`,
          };

          const gzip = Buffer.from(await gzipAsync(identity, {}));

          const gzipHeaders: Headers = {
            "cache-control": cacheControl,
            "content-encoding": "gzip",
            "content-length": gzip.length.toFixed(),
            "content-type": contentType,
            etag: `W/"${createHash("md5").update(gzip).digest("hex")}"`,
          };

          routes[pathname] = {
            br: [brHeaders, br],
            gzip: [gzipHeaders, gzip],
            identity: [identityHeaders, identity],
          };
        }

        globalDefs["@ROUTES"] = `{${Object.entries(routes)
          .map(
            ([pathname, route]) =>
              `${JSON.stringify(pathname)}:{${Object.entries(route)
                .map(
                  ([encoding, [headers, buffer]]) =>
                    `${encoding}:[${JSON.stringify(headers)},Buffer.from("${buffer.toString("base64")}","base64")]`,
                )
                .join()}}`,
          )
          .join()}}`;
      },
    });
  } else {
    const url = "http://127.0.0.1:3000/";
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: null });
    let worker: Worker | undefined;

    process.on("SIGINT", async () => {
      try {
        await browser.close();
        process.exit(0);
      } catch {
        process.exit(1);
      }
    });

    const reload = async () => {
      if (!worker) {
        return;
      }

      if (context.pages().every((page) => !page.url().startsWith(url))) {
        const page = await context.newPage();

        for (let i = 0; i < 10; i++) {
          try {
            await page.goto(url);
            break;
          } catch {}
        }

        return;
      }

      for (let i = 0; i < 10; i++) {
        try {
          await Promise.all(
            context
              .pages()
              .filter((page) => page.url().startsWith(url))
              .map((page) => page.reload()),
          );

          break;
        } catch {}
      }
    };

    clientRollupPlugins.push({
      name: "reload",
      writeBundle: reload,
    });

    serverRollupPlugins.push({
      name: "restart",
      async writeBundle() {
        await worker?.terminate();
        worker = new Worker("./dist/server/index.js");
        await reload();
      },
    });
  }

  return [
    {
      input: "src",
      output: {
        dir: "dist/client",
        entryFileNames: prod ? "[hash].js" : "index.js",
        chunkFileNames: "[hash].js",
        compact: true,
        preferConst: true,
      },
      preserveEntrySignatures: false,
      plugins: [
        json({ preferConst: true }),
        babel({
          extensions: [".tsx", ".ts", ".jsx", ".mjs", ".js", ".cjs"],
          babelHelpers: "bundled",
          babelrc: false,
          configFile: false,
          presets: [
            [env, { bugfixes: true, targets: { esmodules: true }, useBuiltIns: false }],
            [typescript],
            [solid, { hydratable: true, generate: "dom" }],
          ],
          plugins: babelPlugins,
        }),
        alias({
          entries: [{ find: /^~\//, replacement: resolve("src") + "/" }],
        }),
        nodeResolve({
          extensions: [
            ".client.tsx",
            ".client.ts",
            ".client.jsx",
            ".client.mjs",
            ".client.js",
            ".client.cjs",
            ".client.json",
            ".tsx",
            ".ts",
            ".jsx",
            ".mjs",
            ".js",
            ".cjs",
            ".json",
            ".node",
          ],
          browser: true,
          preferBuiltins: false,
          mainFields: ["browser", "module", "main"],
          exportConditions: ["browser", "import", "require", "default"],
        }),
        commonjs({ ignoreGlobal: false }),
        replace({
          preventAssignment: true,
          values: {
            "typeof self": '"object"',
          },
        }),
        prod && terser({ ecma: 2017, safari10: true }),
        ...clientRollupPlugins,
      ],
    },
    {
      input: "src",
      output: {
        dir: "dist/server",
        entryFileNames: "index.js",
        compact: true,
        preferConst: true,
        inlineDynamicImports: true,
      },
      preserveEntrySignatures: false,
      external: builtinModules,
      plugins: [
        json({ preferConst: true }),
        babel({
          extensions: [".tsx", ".ts", ".jsx", ".mjs", ".js", ".cjs"],
          babelHelpers: "bundled",
          babelrc: false,
          configFile: false,
          presets: [
            [env, { bugfixes: true, targets: { node: "current" }, useBuiltIns: false }],
            [typescript],
            [solid, { hydratable: false, generate: "ssr" }],
          ],
          plugins: babelPlugins,
          overrides: [
            {
              test: /\.client\.tsx$/,
              presets: [[solid, { hydratable: true, generate: "ssr" }]],
            },
          ],
        }),
        alias({
          entries: [{ find: /^~\//, replacement: resolve("src") + "/" }],
        }),
        nodeResolve({
          extensions: [
            ".server.tsx",
            ".server.ts",
            ".server.jsx",
            ".server.mjs",
            ".server.js",
            ".server.cjs",
            ".server.json",
            ".tsx",
            ".ts",
            ".jsx",
            ".mjs",
            ".js",
            ".cjs",
            ".json",
            ".node",
          ],
          browser: false,
          preferBuiltins: true,
          mainFields: ["module", "main"],
          exportConditions: ["node", "import", "require", "default"],
        }),
        commonjs({ ignoreGlobal: true }),
        replace({
          preventAssignment: true,
          values: {
            "typeof self": '"undefined"',
          },
        }),
        prod && terser({ ecma: 2020, compress: { global_defs: globalDefs, passes: 10 } }),
        ...serverRollupPlugins,
      ],
    },
  ];
};
