import type { JSX } from "solid-js";

export default (props: { lang?: string; children?: JSX.Element }) => {
  return <html lang={props.lang || "ja"}>{props.children}</html>;
};
