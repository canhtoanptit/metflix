import {
  Button,
  Popover,
  PopoverContent,
  PopoverTrigger,
  RadioGroup,
  RadioItem,
  Select,
  SelectItem,
  SettingsIcon,
} from "@webflix/ui";
import { useState } from "react";
import {
  initialState,
  loadSettings,
  MOCK_STATE_KEY,
  type MockScenario,
  saveSettings,
  saveState,
} from "../../mocks/state.ts";

/**
 * Development-only control (bottom-left): jump to the reference page and, in mock mode, switch
 * the session state, latency and failing endpoints. Changes reload the app.
 */
export function MockToolbar() {
  const [settings] = useState(loadSettings);
  const reload = () => window.location.assign(window.location.pathname);

  return (
    <div className="fixed bottom-3 start-3 z-(--z-toast)" data-testid="dev-toolbar">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="focus-ring flex h-8 items-center gap-1.5 rounded-full border border-line bg-surface-2/90 px-3 type-caption text-fg-muted shadow-md backdrop-blur-md hover:text-fg"
          >
            <SettingsIcon size="sm" />
            {__WEBFLIX_MOCK__ ? "Mock" : "Dev"}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="flex w-72 flex-col gap-5 p-4">
          <Button variant="outline" size="sm" asChild>
            {/* Plain anchor: the dev route is absent from the typed production route tree. */}
            <a href="/dev/reference">Open the design reference</a>
          </Button>
          {__WEBFLIX_MOCK__ ? (
            <>
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 type-overline text-fg-subtle">
                  Session (resets mock data)
                </legend>
                <RadioGroup
                  aria-label="Session"
                  onValueChange={(value) => {
                    saveState(initialState(value as MockScenario));
                    window.location.assign(
                      value === "anonymous" ? "/" : value === "account" ? "/profiles" : "/browse",
                    );
                  }}
                >
                  <RadioItem value="anonymous" label="Signed out" />
                  <RadioItem value="account" label="Signed in, no profile" />
                  <RadioItem value="profile" label="Signed in as Mara" />
                </RadioGroup>
              </fieldset>
              <div className="flex flex-col gap-2">
                <span className="type-overline text-fg-subtle">Latency</span>
                <Select
                  aria-label="Latency"
                  value={String(settings.latencyMs)}
                  onValueChange={(value) => {
                    saveSettings({ ...settings, latencyMs: Number(value) });
                    reload();
                  }}
                >
                  <SelectItem value="0">None</SelectItem>
                  <SelectItem value="250">250 ms</SelectItem>
                  <SelectItem value="1200">1.2 s (see skeletons)</SelectItem>
                  <SelectItem value="4000">4 s</SelectItem>
                </Select>
              </div>
              <div className="flex flex-col gap-2">
                <span className="type-overline text-fg-subtle">Failing endpoints</span>
                <Select
                  aria-label="Failing endpoints"
                  value={settings.failing[0] ?? "none"}
                  onValueChange={(value) => {
                    saveSettings({ ...settings, failing: value === "none" ? [] : [value] });
                    reload();
                  }}
                >
                  <SelectItem value="none">None</SelectItem>
                  <SelectItem value="getBrowse">Browse (getBrowse)</SelectItem>
                  <SelectItem value="getTitle">Title detail (getTitle)</SelectItem>
                  <SelectItem value="addToMyList">Add to My List</SelectItem>
                  <SelectItem value="search">Search</SelectItem>
                </Select>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  localStorage.removeItem(MOCK_STATE_KEY);
                  reload();
                }}
              >
                Reset mock data
              </Button>
            </>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}
