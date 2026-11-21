import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeImageSet, makeProgress } from "@webflix/contracts/fixtures";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogTrigger,
  Field,
  IconButton,
  Input,
  PasswordField,
  PinInput,
  PlayIcon,
  PlusIcon,
  ProgressBar,
  ResponsiveImage,
  Switch,
  TextField,
  TitleTile,
  Toaster,
  toast,
  Wordmark,
} from "../src/index.ts";
import { expectNoA11yViolations } from "../src/testing/index.ts";
import { titleCards } from "./fixtures.ts";

describe("Button", () => {
  it("renders a router link through asChild with its icon", () => {
    render(
      <Button asChild icon={PlayIcon}>
        <a href="/watch/t-1">Play</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Play" });
    expect(link).toHaveAttribute("href", "/watch/t-1");
    expect(link.querySelector('[data-icon="Play"]')).not.toBeNull();
  });

  it("is busy and inert while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("icon buttons require a name and expose toggle state", () => {
    render(<IconButton label="Add to My List" icon={PlusIcon} pressed={false} />);
    expect(screen.getByRole("button", { name: "Add to My List" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });
});

describe("Form controls", () => {
  it("floating-label field: labelled, invalid, error described", () => {
    render(<TextField label="Email address" error="Enter a valid email address." />);
    const input = screen.getByLabelText("Email address");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Enter a valid email address.");
  });

  it("password field toggles visibility", async () => {
    render(<PasswordField label="Password" defaultValue="secret" />);
    const input = screen.getByLabelText("Password");
    expect(input).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Show password" }));
    expect(input).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("Field wires id, hint and error into its control", () => {
    render(
      <Field label="Profile name" error="Already taken">
        <Input defaultValue="Kids" />
      </Field>,
    );
    const input = screen.getByLabelText("Profile name");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("Already taken");
  });

  it("PIN input advances, supports paste and completes", async () => {
    const onComplete = vi.fn();
    function Harness() {
      const [value, setValue] = useState("");
      return (
        <PinInput aria-label="PIN" value={value} onChange={setValue} onComplete={onComplete} />
      );
    }
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Digit 1 of 4"));
    await user.keyboard("12");
    expect(screen.getByLabelText("Digit 3 of 4")).toHaveFocus();
    await user.keyboard("{Backspace}");
    expect(screen.getByLabelText("Digit 2 of 4")).toHaveFocus();
    await user.paste("9876");
    expect(onComplete).toHaveBeenCalledWith("9876");
  });

  it("checkbox and switch report boolean changes", async () => {
    const onCheckbox = vi.fn();
    const onSwitch = vi.fn();
    render(
      <>
        <Checkbox label="Remember me" onCheckedChange={onCheckbox} />
        <Switch label="Autoplay previews" onCheckedChange={onSwitch} />
      </>,
    );
    await userEvent.click(screen.getByLabelText("Remember me"));
    await userEvent.click(screen.getByRole("switch", { name: "Autoplay previews" }));
    expect(onCheckbox).toHaveBeenCalledWith(true);
    expect(onSwitch).toHaveBeenCalledWith(true);
  });
});

describe("ResponsiveImage", () => {
  it("offers AVIF then WebP srcsets, reserves the aspect ratio and shows the dominant colour", () => {
    const image = makeImageSet({ widths: [320, 640], dominantColor: "#1f2a44" });
    const { container } = render(<ResponsiveImage image={image} alt="" sizes="50vw" />);
    const sources = container.querySelectorAll("source");
    expect(Array.from(sources, (source) => source.getAttribute("type"))).toEqual([
      "image/avif",
      "image/webp",
    ]);
    expect(sources[0]?.getAttribute("srcset")).toContain("card-320.avif");
    expect(sources[0]?.getAttribute("sizes")).toBe("50vw");
    const box = container.firstElementChild as HTMLElement;
    expect(box.style.aspectRatio).not.toBe("");
    expect(box.style.backgroundColor).toBe("rgb(31, 42, 68)");
    expect(container.querySelector("img")).toHaveAttribute("loading", "lazy");
  });

  it("loads above-the-fold artwork eagerly with high priority", () => {
    render(<ResponsiveImage image={makeImageSet()} alt="Backdrop" priority />);
    const img = screen.getByAltText("Backdrop");
    expect(img).toHaveAttribute("loading", "eager");
    expect(img).toHaveAttribute("fetchpriority", "high");
  });
});

describe("TitleTile", () => {
  it("names ranked and in-progress tiles for screen readers", () => {
    const [first, second] = titleCards(2);
    if (!first || !second) throw new Error("fixtures");
    render(
      <>
        <TitleTile title={first} layout="ranked" rank={1} href="#a" />
        <TitleTile
          title={second}
          layout="continue"
          progress={makeProgress({ positionSec: 900, durationSec: 3600 })}
          episode={{ id: "e-1", seasonNumber: 1, number: 2, name: "The Ferry" }}
          href="#b"
        />
      </>,
    );
    expect(screen.getByRole("link", { name: /^1\. Title 1/ })).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Title 2, Season 1, episode 2: The Ferry, 25% watched/ }),
    ).toBeInTheDocument();
  });
});

describe("Overlays and feedback", () => {
  it("dialog opens with its title, traps focus and closes on Escape", async () => {
    const user = userEvent.setup();
    render(
      <Dialog>
        <DialogTrigger asChild>
          <Button>Edit</Button>
        </DialogTrigger>
        <DialogContent title="Edit profile">
          <Input aria-label="Name" />
        </DialogContent>
      </Dialog>,
    );
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog", { name: "Edit profile" });
    expect(dialog).toBeInTheDocument();
    await expectNoA11yViolations(dialog);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Edit" })).toHaveFocus();
  });

  it("toasts render from the imperative API", async () => {
    render(<Toaster />);
    act(() => {
      toast.error("Couldn't add to My List", { description: "Please try again." });
    });
    expect(await screen.findByText("Couldn't add to My List")).toBeInTheDocument();
    act(() => toast.reset());
  });

  it("progress exposes its value", () => {
    render(<ProgressBar value={0.42} label="Watched" />);
    expect(screen.getByRole("progressbar", { name: "Watched" })).toHaveAttribute(
      "aria-valuenow",
      "42",
    );
  });

  it("brand wordmark is a named image", () => {
    render(<Wordmark />);
    expect(screen.getByRole("img", { name: "Webflix" })).toBeInTheDocument();
  });
});

describe("Accessibility", () => {
  it("a composed auth form has no axe violations", async () => {
    const { container } = render(
      <form aria-label="Sign in">
        <TextField label="Email address" type="email" />
        <PasswordField label="Password" />
        <Checkbox label="Remember me" />
        <Button type="submit" variant="accent">
          Sign in
        </Button>
      </form>,
    );
    await expectNoA11yViolations(container);
  });
});
