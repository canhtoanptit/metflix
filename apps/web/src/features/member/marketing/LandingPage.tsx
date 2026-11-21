import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ImageSet, Plan } from "@webflix/contracts";
import {
  Accordion,
  AccordionItem,
  Avatar,
  Badge,
  Button,
  cx,
  KidsIcon,
  LockIcon,
  MonitorIcon,
  NextEpisodeIcon,
  ProgressBar,
  ResponsiveImage,
  SmartphoneIcon,
  TabletIcon,
  TvIcon,
} from "@webflix/ui";
import type { ReactNode } from "react";
import { queries } from "../../../app/query/queries.ts";
import { showcaseImage, useShowcase } from "../shared/artwork.ts";
import { MemberFooter, MemberHeader } from "../shared/Chrome.tsx";
import { formatMoney } from "../shared/format.ts";
import { PlanSummary, PlanSummarySkeleton } from "../shared/PlanSummary.tsx";
import { PosterWall } from "../shared/PosterWall.tsx";
import { EmailCapture } from "./EmailCapture.tsx";

/**
 * The marketing landing page: a poster-wall hero with the email capture, what membership feels
 * like (shown with real artwork and real product UI), plans from `GET /plans`, FAQ, and a second
 * capture before the footer.
 */
export function LandingPage() {
  const plans = useQuery(queries.plans());
  const cheapest = plans.data?.items.reduce<Plan | null>(
    (lowest, plan) =>
      !lowest || plan.monthlyPrice.amountMinor < lowest.monthlyPrice.amountMinor ? plan : lowest,
    null,
  );

  return (
    <div className="relative min-h-dvh overflow-x-clip bg-canvas">
      <section className="relative isolate flex min-h-[min(100dvh,56rem)] flex-col">
        <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute inset-0 opacity-50">
            <PosterWall rows={5} priority />
          </div>
          <div className="absolute inset-0 bg-canvas/60" />
          <div className="absolute inset-0 scrim-top" />
          <div className="absolute inset-0 scrim-bottom" />
          <div className="absolute inset-0 bg-glow" />
        </div>
        <MemberHeader
          action={
            <Button variant="accent" size="sm" asChild>
              <Link to="/login" search={{}}>
                Sign in
              </Link>
            </Button>
          }
        />
        <main
          id="main"
          className="mx-auto flex w-full max-w-detail flex-1 flex-col items-center justify-center gap-6 px-gutter py-20 text-center"
        >
          <h1 className="type-display-lg text-fg">Stories that stay with you.</h1>
          <p className="type-body-lg max-w-prose text-fg-muted sm:text-xl">
            Films, series and Webflix Originals on every screen you own.{" "}
            {cheapest ? (
              <>
                Plans from <span className="text-fg">{formatMoney(cheapest.monthlyPrice)}</span> a
                month.
              </>
            ) : null}{" "}
            Cancel anytime.
          </p>
          <EmailCapture
            label="Enter your email to start your membership or sign back in."
            className="mt-2 max-w-dialog-md"
          />
        </main>
      </section>

      <NowShowing />

      <div className="flex flex-col">
        <Feature
          eyebrow="Continue watching"
          title="Pick up right where you left off"
          body="Stop on the train, finish on the sofa. Webflix remembers the exact second for every profile, on every device."
          visual={<ContinueVisual />}
        />
        <Feature
          reverse
          eyebrow="Profiles"
          title="One membership, a profile for everyone"
          body="Up to five profiles, each with its own picks, list and settings. Kids profiles only show titles made for them, and a PIN keeps your profile yours."
          visual={<ProfilesVisual />}
        />
        <Feature
          eyebrow="Made for binge nights"
          title="Skip the intro, not the story"
          body="Skip recaps and opening titles in one tap, and roll straight into the next episode, or switch autoplay off whenever you like."
          visual={<PlayerVisual />}
        />
        <Feature
          reverse
          eyebrow="Anywhere"
          title="Watch on the screens you already have"
          body="Your TV, laptop, tablet or phone: sign in and press play. No box, no setup, no contract."
          visual={<DevicesVisual />}
        />
      </div>

      <section aria-labelledby="plans-heading" className="px-gutter py-20 sm:py-28" id="plans">
        <div className="mx-auto flex max-w-page flex-col gap-10">
          <div className="mx-auto flex max-w-prose flex-col gap-3 text-center">
            <h2 id="plans-heading" className="type-display-md text-fg">
              Choose your plan
            </h2>
            <p className="type-body-lg text-fg-muted">
              Every plan includes the whole catalog with no ads. Switch plans whenever you want.
            </p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {plans.isPending
              ? Array.from({ length: 3 }, (_, index) => <PlanSummarySkeleton key={index} />)
              : plans.isSuccess
                ? plans.data.items.map((plan) => (
                    <div
                      key={plan.id}
                      className={cx(
                        "relative flex flex-col gap-6 rounded-xl border bg-surface-1 p-5 sm:p-6",
                        plan.highlighted ? "border-accent/60 shadow-glow" : "border-line-subtle",
                      )}
                    >
                      <PlanSummary plan={plan} className="flex-1" />
                      <Button
                        variant={plan.highlighted ? "accent" : "outline"}
                        size="lg"
                        fullWidth
                        asChild
                      >
                        <Link to="/signup" search={{ plan: plan.id }}>
                          Choose {plan.name}
                        </Link>
                      </Button>
                    </div>
                  ))
                : null}
          </div>
        </div>
      </section>

      <section aria-labelledby="faq-heading" className="px-gutter pb-20 sm:pb-28" id="faq">
        <div className="mx-auto flex max-w-dialog-lg flex-col gap-8">
          <h2 id="faq-heading" className="type-display-md text-center text-fg">
            Questions, answered
          </h2>
          <Accordion type="single" collapsible variant="faq">
            <AccordionItem value="what" title="What is Webflix?">
              Webflix is a streaming service for films and series, including Webflix Originals you
              won't find anywhere else. Watch as much as you want, whenever you want, for one
              monthly price.
            </AccordionItem>
            <AccordionItem value="cost" title="How much does it cost?">
              {plans.isSuccess
                ? `Plans range from ${plans.data.items.map((plan) => `${formatMoney(plan.monthlyPrice)} (${plan.name})`).join(" to ")} a month. No extra costs, no contracts.`
                : "Plans start at a low monthly price. No extra costs, no contracts."}
            </AccordionItem>
            <AccordionItem value="where" title="Where can I watch?">
              In any modern web browser on your computer, TV, tablet or phone. Sign in with your
              Webflix account and pick up where you left off on any of them.
            </AccordionItem>
            <AccordionItem value="screens" title="How many people can watch at once?">
              It depends on your plan: Basic streams on one screen at a time, Standard on two and
              Premium on four. Everyone can have their own profile, up to five per account.
            </AccordionItem>
            <AccordionItem value="cancel" title="How do I cancel?">
              Online, in two clicks, from your Account page. There are no cancellation fees. You
              keep watching until the end of the period you've paid for, and you can restart
              anytime.
            </AccordionItem>
            <AccordionItem value="kids" title="Is Webflix good for kids?">
              Kids profiles show only titles rated 7+ and under. You can set a maturity rating for
              any profile and lock grown-up profiles with a PIN, so little hands stay where they
              belong.
            </AccordionItem>
            <AccordionItem value="what-to-watch" title="What can I watch on Webflix?">
              Original series and films across drama, thrillers, comedy, sci-fi, documentaries and
              family favourites, alongside acclaimed open films. New titles arrive every week.
            </AccordionItem>
          </Accordion>
          <EmailCapture
            label="Ready? Enter your email to start your membership or sign back in."
            className="mx-auto mt-6 max-w-dialog-md text-center"
          />
        </div>
      </section>

      <MemberFooter>
        <nav aria-label="Footer" className="flex flex-wrap gap-x-6 gap-y-2">
          <a href="#faq" className="focus-ring rounded-xs hover:text-fg hover:underline">
            FAQ
          </a>
          <a href="#plans" className="focus-ring rounded-xs hover:text-fg hover:underline">
            Plans and pricing
          </a>
          <Link
            to="/login"
            search={{}}
            className="focus-ring rounded-xs hover:text-fg hover:underline"
          >
            Sign in
          </Link>
          <Link
            to="/signup"
            search={{}}
            className="focus-ring rounded-xs hover:text-fg hover:underline"
          >
            Create an account
          </Link>
        </nav>
      </MemberFooter>
    </div>
  );
}

function Feature({
  eyebrow,
  title,
  body,
  visual,
  reverse = false,
}: {
  eyebrow: string;
  title: string;
  body: string;
  visual: ReactNode;
  reverse?: boolean;
}) {
  return (
    <section className="border-t border-line-subtle px-gutter py-16 sm:py-24">
      <div
        className={cx(
          "mx-auto grid max-w-page grid-cols-1 items-center gap-10 lg:grid-cols-2 lg:gap-16",
          reverse && "lg:[&>*:first-child]:order-2",
        )}
      >
        <div className="mx-auto flex max-w-prose flex-col gap-4 text-center lg:mx-0 lg:text-start">
          <p className="type-overline text-accent">{eyebrow}</p>
          <h2 className="type-display-md text-fg">{title}</h2>
          <p className="type-body-lg text-fg-muted sm:text-xl">{body}</p>
        </div>
        <div aria-hidden className="relative mx-auto w-full max-w-dialog-lg">
          {visual}
        </div>
      </div>
    </section>
  );
}

/** A band of real catalog posters (decorative: it fades out at the edge, nothing to scroll). */
function NowShowing() {
  const posters = useShowcase()
    .slice(0, 14)
    .map((item) => item.images.poster);
  if (posters.length === 0) return null;
  return (
    <section aria-labelledby="now-on-webflix" className="relative pb-6">
      <h2 id="now-on-webflix" className="mb-4 px-gutter type-row-title text-fg">
        Now on Webflix
      </h2>
      <div
        aria-hidden
        className="flex gap-2 overflow-hidden px-gutter pb-2 [mask-image:linear-gradient(to_right,black_80%,transparent)] sm:gap-3"
      >
        {posters.map((image) => (
          <ResponsiveImage
            key={image.template}
            image={image}
            alt=""
            sizes="(min-width: 1100px) 12vw, (min-width: 500px) 22vw, 36vw"
            className="w-[36vw] shrink-0 overflow-hidden rounded-card sm:w-[22vw] lg:w-[12vw]"
          />
        ))}
      </div>
    </section>
  );
}

/** 16:9 showcase artwork, or a quiet frame of the same shape while it loads or if it cannot. */
function Artwork({
  image,
  sizes,
  className,
}: {
  image: ImageSet | null;
  sizes: string;
  className?: string;
}) {
  if (image) {
    return <ResponsiveImage image={image} alt="" sizes={sizes} className={className} />;
  }
  return <span className={cx("block aspect-video bg-surface-2", className)} />;
}

function Screen({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cx(
        "overflow-hidden rounded-2xl border border-line bg-surface-1 p-2 shadow-xl sm:p-3",
        className,
      )}
    >
      <div className="overflow-hidden rounded-lg bg-canvas">{children}</div>
    </div>
  );
}

function ContinueVisual() {
  const showcase = useShowcase();
  const items: Array<[number, number]> = [
    [1, 0.62],
    [4, 0.28],
    [7, 0.85],
  ];
  return (
    <Screen>
      <div className="flex flex-col gap-3 p-4 sm:p-6">
        <p className="type-label text-fg">Continue Watching for Sam</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {items.map(([slot, progress], index) => (
            <div
              key={slot}
              className={cx("flex flex-col gap-1.5", index === 2 && "hidden sm:flex")}
            >
              <Artwork
                image={showcaseImage(showcase, slot, "card")}
                sizes="(min-width: 800px) 14vw, 40vw"
                className="overflow-hidden rounded-card"
              />
              <ProgressBar value={progress} size="sm" />
            </div>
          ))}
        </div>
      </div>
    </Screen>
  );
}

function ProfilesVisual() {
  const people = [
    { name: "Sam", avatar: "a-sunny", extra: null },
    { name: "Alex", avatar: "a-midnight-cat", extra: <LockIcon size="sm" /> },
    { name: "Robin", avatar: "a-bubblegum", extra: null },
    { name: "Kids", avatar: "a-bamboo", extra: <KidsIcon size="sm" /> },
  ];
  return (
    <div className="flex flex-col items-center gap-6 rounded-2xl border border-line-subtle bg-surface-1 px-6 py-10">
      <p className="type-title-lg text-fg">Who's watching?</p>
      <div className="grid grid-cols-2 gap-6 sm:grid-cols-4">
        {people.map((person) => (
          <div key={person.name} className="flex flex-col items-center gap-2">
            <span className="size-20 text-3xl sm:size-24">
              <Avatar
                src={`/cdn/img/avatars/${person.avatar}.webp`}
                name={person.name}
                size="fill"
                decorative
              />
            </span>
            <span className="inline-flex items-center gap-1.5 type-body-sm text-fg-muted">
              {person.name}
              {person.extra}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PlayerVisual() {
  const showcase = useShowcase();
  return (
    <Screen>
      <div className="relative">
        <Artwork
          image={showcaseImage(showcase, 2, "backdrop")}
          sizes="(min-width: 800px) 45vw, 92vw"
          className="block"
        />
        <div className="absolute inset-0 scrim-bottom" />
        <span className="absolute end-3 bottom-14 rounded-control border border-line-strong bg-glass px-3 py-1.5 type-label text-fg backdrop-blur-md sm:end-5 sm:bottom-16 sm:px-4 sm:py-2">
          Skip Intro
        </span>
        <div className="absolute inset-x-3 bottom-4 flex items-center gap-3 sm:inset-x-5 sm:bottom-6">
          <ProgressBar value={0.08} size="sm" track="onImage" className="flex-1" />
          <span className="type-caption text-fg-muted tabular-nums">41:12</span>
        </div>
      </div>
      <div className="flex items-center gap-3 border-t border-line-subtle p-3 sm:p-4">
        <Artwork
          image={showcaseImage(showcase, 5, "card")}
          sizes="8rem"
          className="w-24 shrink-0 overflow-hidden rounded-sm sm:w-32"
        />
        <div className="flex min-w-0 flex-col gap-1">
          <Badge tone="neutral" size="sm" className="self-start">
            Next episode in 5
          </Badge>
          <span className="truncate type-label text-fg">Episode 4</span>
        </div>
        <NextEpisodeIcon size="lg" className="ms-auto text-fg-muted" />
      </div>
    </Screen>
  );
}

function DevicesVisual() {
  const devices = [
    { icon: TvIcon, label: "TV" },
    { icon: MonitorIcon, label: "Computer" },
    { icon: TabletIcon, label: "Tablet" },
    { icon: SmartphoneIcon, label: "Phone" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4">
      {devices.map((device) => (
        <div
          key={device.label}
          className="flex flex-col items-center gap-3 rounded-2xl border border-line-subtle bg-surface-1 px-4 py-8"
        >
          <span className="grid size-14 place-items-center rounded-full bg-accent-subtle text-accent">
            <device.icon size="xl" />
          </span>
          <span className="type-label text-fg">{device.label}</span>
        </div>
      ))}
    </div>
  );
}
