import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.tsx";
import { createDefaultApiClient } from "./app/api.ts";
import { createAppRuntime } from "./app/bootstrap.ts";
import "./app/env.ts";
import "./styles/app.css";

async function start() {
  // Mock mode answers the API in the browser; the module is dropped from production builds.
  const apiClient = __WEBFLIX_MOCK__
    ? (await import("./mocks/client.ts")).createMockApiClient()
    : createDefaultApiClient();
  const { queryClient, router } = createAppRuntime(apiClient);

  const container = document.getElementById("root");
  if (!container) throw new Error("#root is missing from index.html");
  createRoot(container).render(
    <StrictMode>
      <App queryClient={queryClient} router={router} />
    </StrictMode>,
  );
}

void start();
