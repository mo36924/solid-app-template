import type { JSX } from "solid-js";

export default (props: { children?: JSX.Element }) => {
  return (
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      {props.children}
      <link rel="stylesheet" href={typeof URL_CSS === "string" ? URL_CSS : "/index.css"}></link>
      <script type="module" src={typeof URL_JS === "string" ? URL_JS : "/index.js"}></script>
    </head>
  );
};
