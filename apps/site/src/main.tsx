/* @refresh reload */
import { render } from "solid-js/web";
import { RouterProvider } from "@tanstack/solid-router";
import { router } from "./router.tsx";
import "@markdraw/ui/styles/index.css";
import "./styles.css";

const root = document.getElementById("root");

if (root) {
  render(() => <RouterProvider router={router} />, root);
}
