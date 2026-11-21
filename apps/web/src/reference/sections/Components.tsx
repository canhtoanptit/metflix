import {
  Accordion,
  AccordionItem,
  Avatar,
  Badge,
  BUTTON_VARIANTS,
  Button,
  type ButtonSize,
  type ButtonVariant,
  Checkbox,
  CheckIcon,
  Cluster,
  ConfirmDialog,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  EmptyState,
  ErrorState,
  Field,
  IconButton,
  InfoIcon,
  Input,
  ListIcon,
  LogOutIcon,
  MaturityBadge,
  PasswordField,
  PinInput,
  PlayIcon,
  PlusIcon,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ProgressBar,
  QualityBadge,
  RadioCard,
  RadioGroup,
  RadioItem,
  ResponsiveImage,
  SearchIcon,
  SearchInput,
  SegmentedControl,
  Select,
  SelectItem,
  SheetContent,
  Skeleton,
  SkeletonText,
  Spinner,
  Stack,
  Surface,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  TextField,
  ThumbsDownIcon,
  ThumbsUpDoubleIcon,
  ThumbsUpIcon,
  TitleBadge,
  Tooltip,
  Top10Badge,
  toast,
  UserIcon,
  UsersIcon,
  VolumeMuteIcon,
} from "@webflix/ui";
import { allIcons } from "@webflix/ui/icons/catalog";
import { useState } from "react";
import { avatarCatalog, PLANS } from "../../mocks/catalog.ts";
import { detail, sample } from "../data.ts";
import { Caption, Demo, Labeled, Section } from "../Specimen.tsx";

const VARIANTS = Object.keys(BUTTON_VARIANTS) as ButtonVariant[];
const SIZES: ButtonSize[] = ["sm", "md", "lg", "xl", "hero"];
const MATURITY = ["ALL", "7+", "13+", "16+", "18+"] as const;
const avatars = avatarCatalog().groups.flatMap((group) => group.avatars);

function IconsDemo() {
  const [size, setSize] = useState<"sm" | "md" | "lg" | "xl">("lg");
  return (
    <>
      <SegmentedControl
        aria-label="Icon size"
        value={size}
        onValueChange={setSize}
        options={[
          { value: "sm", label: "16" },
          { value: "md", label: "20" },
          { value: "lg", label: "24" },
          { value: "xl", label: "32" },
        ]}
      />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
        {Object.entries(allIcons).map(([name, Icon]) => (
          <div
            key={name}
            className="flex flex-col items-center gap-2 rounded-md bg-surface-1 px-2 py-4"
          >
            <Icon size={size} />
            <Caption>{name}</Caption>
          </div>
        ))}
      </div>
    </>
  );
}

function FilterDemo() {
  const [type, setType] = useState<"all" | "movie" | "series">("all");
  return (
    <SegmentedControl
      aria-label="Show"
      size="md"
      value={type}
      onValueChange={setType}
      options={[
        { value: "all", label: "All" },
        { value: "movie", label: "Movies" },
        { value: "series", label: "Series" },
      ]}
    />
  );
}

function FormsDemo() {
  const [pin, setPin] = useState("12");
  const [search, setSearch] = useState("Meridian");
  const [plan, setPlan] = useState("standard");
  return (
    <>
      <Demo
        title="Floating-label field (auth screens)"
        className="grid w-full grid-cols-1 items-start gap-4 sm:grid-cols-2 lg:grid-cols-3"
      >
        <TextField label="Email address" type="email" />
        <TextField label="Email address" type="email" defaultValue="demo@webflix.dev" />
        <TextField
          label="Email address"
          type="email"
          defaultValue="demo@webflix"
          error="Enter a valid email address."
        />
        <PasswordField label="Password" defaultValue="webflix-demo" />
        <TextField label="Disabled" defaultValue="Can't touch this" disabled />
        <TextField label="With hint" hint="We'll send a sign-in code here." />
      </Demo>
      <Demo
        title="Stacked field (settings)"
        className="grid w-full grid-cols-1 items-start gap-6 sm:grid-cols-2 lg:grid-cols-3"
      >
        <Field label="Profile name" hint="Up to 30 characters.">
          <Input defaultValue="Mara" />
        </Field>
        <Field label="Profile name" error="A profile with this name already exists.">
          <Input defaultValue="Kids" />
        </Field>
        <Field label="Maturity rating">
          <Select defaultValue="18+">
            {MATURITY.map((level) => (
              <SelectItem key={level} value={level}>
                {level === "ALL" ? "All ages" : level}
              </SelectItem>
            ))}
          </Select>
        </Field>
      </Demo>
      <Demo title="Segmented control" note="An immediate single choice (not tabs).">
        <FilterDemo />
      </Demo>
      <Demo title="Search and solid select">
        <SearchInput
          label="Search titles, people, genres"
          placeholder="Titles, people, genres"
          value={search}
          onValueChange={setSearch}
          className="w-80"
        />
        <Select variant="solid" defaultValue="1" aria-label="Season">
          <SelectItem value="1" meta="8 episodes">
            Season 1
          </SelectItem>
          <SelectItem value="2" meta="10 episodes">
            Season 2
          </SelectItem>
          <SelectItem value="3" meta="6 episodes">
            Season 3
          </SelectItem>
        </Select>
      </Demo>
      <Demo title="Choice controls" className="items-start gap-10">
        <Stack gap={3}>
          <Checkbox label="Remember me" defaultChecked />
          <Checkbox label="Unchecked" />
          <Checkbox label="Indeterminate" checked="indeterminate" />
          <Checkbox label="Disabled" disabled />
        </Stack>
        <Stack gap={4} className="w-80">
          <Switch
            label="Autoplay next episode"
            description="Start the next episode after the countdown."
            defaultChecked
          />
          <Switch label="Autoplay previews" description="Play previews while browsing." />
        </Stack>
        <RadioGroup aria-label="Subtitles" defaultValue="en">
          <RadioItem value="off" label="Off" />
          <RadioItem value="en" label="English" description="Default for this profile" />
          <RadioItem value="vi" label="Tiếng Việt" />
        </RadioGroup>
      </Demo>
      <Demo title="Radio cards (plan selection)" className="block w-full">
        <RadioGroup
          aria-label="Plan"
          value={plan}
          onValueChange={setPlan}
          className="grid w-full gap-4 md:grid-cols-3"
        >
          {PLANS.map((option) => (
            <RadioCard key={option.id} value={option.id}>
              <span className="type-title-lg text-fg">{option.name}</span>
              <span className="mt-1 type-body text-fg-muted">
                ${(option.monthlyPrice.amountMinor / 100).toFixed(2)}/month · {option.maxQuality}
              </span>
              <ul className="mt-4 flex flex-col gap-1.5 type-body-sm text-fg-muted">
                {option.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2">
                    <CheckIcon size="sm" className="mt-0.5 text-accent" />
                    {feature}
                  </li>
                ))}
              </ul>
            </RadioCard>
          ))}
        </RadioGroup>
      </Demo>
      <Demo title="PIN input" className="items-start gap-10">
        <Labeled label="typing">
          <PinInput aria-label="Profile PIN" value={pin} onChange={setPin} />
        </Labeled>
        <Labeled label="error">
          <PinInput aria-label="Profile PIN (error)" value="9876" onChange={() => {}} error />
        </Labeled>
      </Demo>
    </>
  );
}

function OverlaysDemo() {
  const [confirm, setConfirm] = useState(false);
  return (
    <Cluster gap={4}>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline">Dialog</Button>
        </DialogTrigger>
        <DialogContent title="Edit profile" description="Changes apply on every device." size="md">
          <Stack gap={5}>
            <Field label="Profile name">
              <Input defaultValue="Mara" />
            </Field>
            <Switch label="Kids profile" />
          </Stack>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <DialogClose asChild>
              <Button variant="accent">Save</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline">Detail modal shell</Button>
        </DialogTrigger>
        <DialogContent
          title={detail?.name ?? "Detail"}
          hideTitle
          size="detail"
          placement="top"
          bleed
        >
          {detail ? (
            <>
              <div className="relative aspect-video">
                <ResponsiveImage image={detail.images.backdrop} alt="" fill sizes="850px" />
                <div className="absolute inset-0 bg-linear-to-t from-surface-2 to-transparent" />
              </div>
              <div className="flex flex-col gap-4 p-8">
                <h2 className="type-display-md">{detail.name}</h2>
                <p className="type-body-lg text-fg-muted">{detail.synopsis}</p>
                <SkeletonText lines={12} />
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
      <Button variant="outline" onClick={() => setConfirm(true)}>
        Confirm dialog
      </Button>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Delete Theo's profile?"
        description="Their history, My List and ratings will be gone for good."
        confirmLabel="Delete profile"
        onConfirm={() => setConfirm(false)}
      />
      <Dialog>
        <DialogTrigger asChild>
          <Button variant="outline">Sheet</Button>
        </DialogTrigger>
        <SheetContent title="Browse" side="end">
          <Stack gap={2}>
            {["Home", "Series", "Movies", "New & Popular", "My List"].map((item) => (
              <Button key={item} variant="ghost" className="justify-start">
                {item}
              </Button>
            ))}
          </Stack>
        </SheetContent>
      </Dialog>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline">Popover</Button>
        </PopoverTrigger>
        <PopoverContent arrow className="flex items-center gap-1 rounded-full p-1.5">
          <Tooltip content="Not for me">
            <IconButton label="Not for me" icon={ThumbsDownIcon} />
          </Tooltip>
          <Tooltip content="I like this">
            <IconButton label="I like this" icon={ThumbsUpIcon} />
          </Tooltip>
          <Tooltip content="Love this!">
            <IconButton label="Love this!" icon={ThumbsUpDoubleIcon} />
          </Tooltip>
        </PopoverContent>
      </Popover>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline">Dropdown menu</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel>Profiles</DropdownMenuLabel>
          {avatars.slice(0, 3).map((avatar, index) => (
            <DropdownMenuItem
              key={avatar.id}
              leading={<Avatar src={avatar.imageUrl} name={avatar.name} size="xs" decorative />}
            >
              {["Mara", "Theo", "Kids"][index]}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={UsersIcon}>Manage profiles</DropdownMenuItem>
          <DropdownMenuItem icon={UserIcon}>Account</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem icon={LogOutIcon} tone="danger">
            Sign out of Webflix
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Tooltip content="Add to My List">
        <Button variant="outline">Tooltip</Button>
      </Tooltip>
    </Cluster>
  );
}

export function Components() {
  return (
    <>
      <Section
        id="icons"
        title="Icons"
        description="70+ icons on a 24px grid, 2px round strokes; media transport icons are solid. Decorative by default; pass `label` when an icon stands alone."
      >
        <IconsDemo />
      </Section>

      <Section
        id="buttons"
        title="Buttons"
        description="Variants by role. Hero size scales with the viewport for the billboard. Focus rings: white ring, dark gap and halo — visible on canvas and on any artwork."
      >
        {VARIANTS.map((variant) => (
          <Demo key={variant} title={variant} note={variantNote(variant)}>
            {SIZES.map((size) => (
              <Button
                key={size}
                variant={variant}
                size={size}
                icon={
                  variant === "primary" ? PlayIcon : variant === "secondary" ? InfoIcon : undefined
                }
              >
                {variant === "primary"
                  ? "Play"
                  : variant === "secondary"
                    ? "More info"
                    : labelFor(variant)}
              </Button>
            ))}
            <Button variant={variant} data-force-focus="">
              Focused
            </Button>
            <Button variant={variant} disabled>
              Disabled
            </Button>
            <Button variant={variant} loading>
              Loading
            </Button>
          </Demo>
        ))}
        <Demo title="Over artwork" note="Primary and secondary are designed for the billboard.">
          <div className="relative w-full overflow-hidden rounded-xl">
            <ResponsiveImage image={sample.images.card} alt="" sizes="100vw" />
            <div className="absolute inset-0 scrim-start" />
            <Cluster className="absolute bottom-[12%] start-[5%]">
              <Button size="hero" icon={PlayIcon}>
                Play
              </Button>
              <Button size="hero" variant="secondary" icon={InfoIcon}>
                More info
              </Button>
              <IconButton label="Unmute" icon={VolumeMuteIcon} variant="glass" size="hero" />
            </Cluster>
          </div>
        </Demo>
        <Demo
          title="Icon buttons"
          note="Round; `label` is required. outline = preview actions, glass = over artwork, ghost = navigation."
        >
          {(["solid", "outline", "glass", "ghost"] as const).map((variant) => (
            <Labeled key={variant} label={variant}>
              <Cluster gap={2}>
                <IconButton variant={variant} size="sm" label="Play" icon={PlayIcon} />
                <IconButton variant={variant} size="md" label="Add to My List" icon={PlusIcon} />
                <IconButton variant={variant} size="lg" label="Search" icon={SearchIcon} />
              </Cluster>
            </Labeled>
          ))}
          <Labeled label="pressed (in My List)">
            <IconButton
              variant="outline"
              size="lg"
              label="Remove from My List"
              icon={CheckIcon}
              pressed
            />
          </Labeled>
          <Labeled label="focused">
            <IconButton
              variant="outline"
              size="lg"
              label="Rate"
              icon={ThumbsUpIcon}
              data-force-focus=""
            />
          </Labeled>
          <Labeled label="loading">
            <IconButton variant="outline" size="lg" label="Saving" icon={ListIcon} loading />
          </Labeled>
          <Labeled label="tooltip">
            <Tooltip content="More info">
              <IconButton variant="outline" size="lg" label="More info" icon={InfoIcon} />
            </Tooltip>
          </Labeled>
        </Demo>
      </Section>

      <Section id="badges" title="Badges and labels">
        <Demo title="Badge tones">
          {(["accent", "neutral", "outline", "positive", "danger", "glass"] as const).map(
            (tone) => (
              <Badge key={tone} tone={tone}>
                {tone}
              </Badge>
            ),
          )}
          {(["accent", "neutral"] as const).map((tone) => (
            <Badge key={`sm-${tone}`} tone={tone} size="sm">
              New
            </Badge>
          ))}
        </Demo>
        <Demo title="Title badges (contract TitleCard.badge)">
          {(["new", "new-episodes", "leaving-soon", "top-10"] as const).map((badge) => (
            <Labeled key={badge} label={badge}>
              <TitleBadge badge={badge} />
            </Labeled>
          ))}
          <Labeled label="Top 10 at 24px">
            <Top10Badge className="text-2xl" />
          </Labeled>
        </Demo>
        <Demo title="Maturity and quality" className="type-body text-fg-muted">
          {MATURITY.map((level) => (
            <MaturityBadge key={level} rating={level} />
          ))}
          <MaturityBadge rating="16+" descriptors={["violence", "language"]} />
          <QualityBadge>HD</QualityBadge>
          <QualityBadge>4K</QualityBadge>
          <QualityBadge>5.1</QualityBadge>
          <QualityBadge>AD</QualityBadge>
        </Demo>
      </Section>

      <Section id="feedback" title="Loading, progress and toasts">
        <Demo title="Spinner">
          <Spinner size="sm" />
          <Spinner size="md" />
          <Spinner size="lg" />
          <Spinner size="xl" />
        </Demo>
        <Demo
          title="Skeletons"
          note="Shimmer stops under reduced motion"
          className="w-full items-start"
        >
          <Skeleton radius="card" aspectRatio={16 / 9} className="w-64" />
          <Skeleton radius="card" aspectRatio={2 / 3} className="w-28" />
          <div className="flex w-72 flex-col gap-3">
            <Skeleton radius="sm" className="h-6 w-40" />
            <SkeletonText lines={3} />
          </div>
        </Demo>
        <Demo title="Progress" className="w-full max-w-prose flex-col items-stretch">
          {[0.08, 0.45, 0.92].map((value) => (
            <ProgressBar key={value} value={value} label="Watched" size="md" />
          ))}
          <ProgressBar value={0.6} size="lg" label="Step 3 of 4" />
        </Demo>
        <Demo title="Toasts">
          <Button
            variant="outline"
            onClick={() => toast.show({ title: "Added to My List", description: "Meridian" })}
          >
            Neutral
          </Button>
          <Button variant="outline" onClick={() => toast.success("Profile saved")}>
            Success
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              toast.error("Couldn't remove from My List", {
                description: "Check your connection and try again.",
                action: { label: "Retry", onClick: () => toast.success("Removed") },
              })
            }
          >
            Error with action
          </Button>
        </Demo>
      </Section>

      <Section
        id="media"
        title="Avatars and artwork"
        description="ResponsiveImage takes the contract ImageSet: AVIF/WebP srcset, a blur-up from the ThumbHash over the dominant colour, and a reserved box, so nothing shifts when artwork arrives."
      >
        <Demo title="Avatars">
          {(["xs", "sm", "md", "lg", "gate"] as const).map((size, index) => (
            <Labeled key={size} label={size}>
              <Avatar
                src={avatars[index]?.imageUrl}
                name={avatars[index]?.name ?? "Profile"}
                size={size}
              />
            </Labeled>
          ))}
          <Labeled label="fallback">
            <Avatar name="Theo" size="lg" />
          </Labeled>
        </Demo>
        <Demo title="Artwork kinds" className="items-end">
          <Labeled label="card 16:9">
            <ResponsiveImage
              image={sample.images.card}
              alt=""
              sizes="320px"
              className="w-80 rounded-card"
            />
          </Labeled>
          <Labeled label="poster 2:3">
            <ResponsiveImage
              image={sample.images.poster}
              alt=""
              sizes="150px"
              className="w-36 rounded-card"
            />
          </Labeled>
          {sample.images.logo ? (
            <Labeled label="logo (transparent)">
              <ResponsiveImage
                image={sample.images.logo}
                alt=""
                sizes="320px"
                fit="contain"
                placeholder="none"
                className="w-80"
              />
            </Labeled>
          ) : null}
          <Labeled label="blur-up only (image never arrives)">
            <ResponsiveImage
              image={{ ...sample.images.card, template: "/cdn/missing/{width}.{format}" }}
              alt=""
              sizes="320px"
              className="w-80 rounded-card"
            />
          </Labeled>
        </Demo>
      </Section>

      <Section id="forms" title="Forms">
        <FormsDemo />
      </Section>

      <Section
        id="overlays"
        title="Overlays"
        description="Radix primitives: focus trapped and restored, Escape closes, scroll locked, correct roles."
      >
        <OverlaysDemo />
      </Section>

      <Section id="disclosure" title="Tabs and accordion">
        <Tabs defaultValue="episodes" className="w-full max-w-prose">
          <TabsList aria-label="Title sections">
            <TabsTrigger value="episodes">Episodes</TabsTrigger>
            <TabsTrigger value="similar">More like this</TabsTrigger>
            <TabsTrigger value="about">About</TabsTrigger>
          </TabsList>
          <TabsContent value="episodes">
            <SkeletonText lines={2} />
          </TabsContent>
          <TabsContent value="similar">More like this…</TabsContent>
          <TabsContent value="about">About…</TabsContent>
        </Tabs>
        <Accordion type="single" collapsible defaultValue="what" className="w-full max-w-detail">
          <AccordionItem value="what" title="What is Webflix?">
            Webflix is a streaming service with award-winning series, films, documentaries and
            originals — on every screen you own.
          </AccordionItem>
          <AccordionItem value="cost" title="How much does Webflix cost?">
            Plans range from $7.99 to $22.99 a month. No extra costs, no contracts.
          </AccordionItem>
          <AccordionItem value="cancel" title="Can I cancel anytime?">
            Yes. Cancel online in two clicks; your membership runs until the end of the billing
            period.
          </AccordionItem>
        </Accordion>
        <Accordion type="multiple" variant="plain" className="w-full max-w-prose">
          <AccordionItem value="a" title="Playback settings">
            Autoplay next episode, previews and subtitle defaults.
          </AccordionItem>
          <AccordionItem value="b" title="Profile lock">
            Require a 4-digit PIN to open this profile.
          </AccordionItem>
        </Accordion>
      </Section>

      <Section id="states" title="Empty, error and layout">
        <div className="grid w-full gap-6 lg:grid-cols-2">
          <Surface>
            <EmptyState
              icon={ListIcon}
              title="Your list is empty"
              description="Add shows and movies to your list to watch them later."
              action={<Button variant="primary">Browse titles</Button>}
            />
          </Surface>
          <Surface>
            <ErrorState
              title="Something went wrong on our side"
              description="We're on it. Please try again in a moment."
              reference="req-7f3a91c2"
              action={<Button variant="outline">Try again</Button>}
            />
          </Surface>
        </div>
      </Section>
    </>
  );
}

function variantNote(variant: ButtonVariant): string {
  return {
    primary: "Play, the main action over artwork",
    accent: "Brand calls to action: Get started, Sign in, Continue",
    secondary: "Frosted, over artwork: More info",
    outline: "Quiet secondary: Manage profiles, Cancel",
    ghost: "Toolbars and menus",
    danger: "Destructive confirmation",
    link: "Inline text action",
  }[variant];
}

function labelFor(variant: ButtonVariant): string {
  return {
    primary: "Play",
    accent: "Get started",
    secondary: "More info",
    outline: "Manage profiles",
    ghost: "Settings",
    danger: "Delete profile",
    link: "Learn more",
  }[variant];
}
