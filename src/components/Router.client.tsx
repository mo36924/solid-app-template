import type { JSX } from "solid-js/jsx-runtime";
import { lazy, Suspense } from "solid-js";

const Index = lazy(() => import("../routes/index.client"));

type Route<T = (props?: any) => JSX.Element> = T & {
  preload: (props?: any) => Promise<T>;
};

export const staticRoutes: { [pathname: string]: Route | undefined } = {
  "/": Index as Route,
};

export const dynamicRoutes: [RegExp, string[], Route][] = [];

export const errorRoutes: { [pathname: string]: Route | undefined } = {};

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

  return (
    (Route as Route | undefined) && {
      Route,
      props,
      Router: () => (
        <Suspense>
          <Route {...props} />
        </Suspense>
      ),
    }
  );
};

export default (props: { url: URL }) => {
  const matches = match(props.url);
  return matches && <matches.Router />;
};
