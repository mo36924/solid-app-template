import { hydrate } from "solid-js/web";
import Router from "~/components/Router";

hydrate(() => <Router url={new URL(location.href)}></Router>, document.getElementById("body")!);
