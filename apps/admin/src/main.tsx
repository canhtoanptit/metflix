// First: before any module that may load zod (zod-jitless.ts says why).
import "./zod-jitless.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Boot } from "./app/Boot.tsx";
import "./styles/admin.css";

const container = document.getElementById("root");
if (!container) throw new Error("#root is missing from index.html");
createRoot(container).render(
  <StrictMode>
    <Boot />
  </StrictMode>,
);
