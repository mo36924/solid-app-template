import type { JSX } from "solid-js/jsx-runtime";
import { Suspense } from "solid-js";
import UserId from "../routes/user/_id";
import _404 from "../routes/404";
import _500 from "../routes/500";
import Index from "../routes/index";

type Route<T = (props?: any) => JSX.Element> = T;

export const staticRoutes: { [pathname: string]: Route | undefined } = {
  "/": Index as Route,
};

export const dynamicRoutes: [RegExp, string[], Route][] = [
  [/^\/user\/([^\/]+?)$/, ["id"], UserId as Route<(props: { id: string }) => JSX.Element>],
];

export const errorRoutes: { [pathname: string]: Route | undefined } = {
  404: _404 as Route,
  500: _500 as Route,
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
