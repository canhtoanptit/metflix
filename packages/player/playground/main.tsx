import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./playground.css";

const root = document.getElementById("root");
if (root) {
  // StrictMode on purpose: mount → unmount → mount must leave no leaked engine or listeners.
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
