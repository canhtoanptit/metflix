/**
 * @webflix/ui: the Webflix design system. Tokens live in CSS (`@webflix/ui/styles.css`);
 * components read them through Tailwind utilities and never hard-code values.
 * Usage notes: docs/DESIGN_SYSTEM.md. Living reference: /dev/reference in the web app.
 */

export type {
  AppIconProps,
  BrandMarkProps,
  OriginalLabelProps,
  WordmarkProps,
} from "./brand/Brand.tsx";
// Brand
export { AppIcon, BrandMark, OriginalLabel, Wordmark } from "./brand/Brand.tsx";
// Disclosure
export { Accordion, AccordionItem } from "./components/Accordion.tsx";
export type { AvatarProps, AvatarSize } from "./components/Avatar.tsx";
export { Avatar } from "./components/Avatar.tsx";
export type { BadgeProps, BadgeTone, MaturityBadgeProps } from "./components/Badge.tsx";
// Display
export {
  Badge,
  MaturityBadge,
  QualityBadge,
  TITLE_BADGE_LABELS,
  TitleBadge,
  Top10Badge,
} from "./components/Badge.tsx";
export type { ButtonProps, ButtonSize, ButtonVariant } from "./components/Button.tsx";
// Actions
export { BUTTON_VARIANTS, Button } from "./components/Button.tsx";
export type { CheckboxProps } from "./components/Checkbox.tsx";
// Forms
export { Checkbox } from "./components/Checkbox.tsx";
export type {
  ConfirmDialogProps,
  DialogContentProps,
  SheetContentProps,
} from "./components/Dialog.tsx";
// Overlays
export {
  ConfirmDialog,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTrigger,
  SheetContent,
} from "./components/Dialog.tsx";
export {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/DropdownMenu.tsx";
export type { FieldProps, InputProps } from "./components/Field.tsx";
export { Field, FieldMessage, Input, Label, useFieldControl } from "./components/Field.tsx";
export type { IconButtonProps, IconButtonVariant } from "./components/IconButton.tsx";
export { IconButton } from "./components/IconButton.tsx";
// Layout
export {
  Cluster,
  Gutter,
  LazyMount,
  PageContainer,
  Separator,
  SkipLink,
  Stack,
  Surface,
} from "./components/Layout.tsx";
export type { PinInputHandle, PinInputProps } from "./components/PinInput.tsx";
export { PinInput } from "./components/PinInput.tsx";
export {
  Popover,
  PopoverAnchor,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
} from "./components/Popover.tsx";
export type { ProgressBarProps } from "./components/ProgressBar.tsx";
export { ProgressBar } from "./components/ProgressBar.tsx";
export type { RadioCardProps, RadioGroupProps, RadioItemProps } from "./components/RadioGroup.tsx";
export { RadioCard, RadioGroup, RadioItem } from "./components/RadioGroup.tsx";
export type { ResponsiveImageProps } from "./components/ResponsiveImage.tsx";
export { ResponsiveImage } from "./components/ResponsiveImage.tsx";
export type { SearchInputProps } from "./components/SearchInput.tsx";
export { SearchInput } from "./components/SearchInput.tsx";
export type { SegmentedControlProps } from "./components/SegmentedControl.tsx";
export { SegmentedControl } from "./components/SegmentedControl.tsx";
export type { SelectItemProps, SelectProps } from "./components/Select.tsx";
export { Select, SelectItem } from "./components/Select.tsx";
export type { SkeletonProps } from "./components/Skeleton.tsx";
export { Skeleton, SkeletonText } from "./components/Skeleton.tsx";
export type { SpinnerProps } from "./components/Spinner.tsx";
export { Spinner } from "./components/Spinner.tsx";
export type { EmptyStateProps, ErrorStateProps } from "./components/States.tsx";
export { EmptyState, ErrorState } from "./components/States.tsx";
export type { SwitchProps } from "./components/Switch.tsx";
export { Switch } from "./components/Switch.tsx";
export { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/Tabs.tsx";
export type { PasswordFieldProps, TextFieldProps } from "./components/TextField.tsx";
export { PasswordField, TextField } from "./components/TextField.tsx";
export type { ToastOptions, ToastTone } from "./components/Toast.tsx";
export { Toaster, toast } from "./components/Toast.tsx";
export type { TooltipProps } from "./components/Tooltip.tsx";
export { Tooltip, TooltipProvider } from "./components/Tooltip.tsx";
export { UiProvider } from "./components/UiProvider.tsx";
// Icons
export * from "./icons/index.ts";
// Utilities
export { parseCssTime, readCssTime } from "./lib/css-time.ts";
export { cx } from "./lib/cx.ts";
export {
  mergeRefs,
  prefersReducedMotion,
  useCanHover,
  useInView,
  useLatest,
  useMediaQuery,
  useReducedMotion,
} from "./lib/hooks.ts";
export { thumbhashToDataUrl } from "./lib/thumbhash.ts";
export type {
  RowSliderHandle,
  RowSliderHoverEvent,
  RowSliderItemContext,
  RowSliderProps,
  SliderMode,
} from "./slider/RowSlider.tsx";
export { RowSlider } from "./slider/RowSlider.tsx";
// Browse
export { RowHeaderLink, RowSliderSkeleton } from "./slider/RowSliderSkeleton.tsx";
export { SLIDER_PER_PAGE, sliderImageSizes } from "./slider/sizes.ts";
export type { TitleTileProps } from "./slider/TitleTile.tsx";
export { TitleTile, TitleTileSkeleton } from "./slider/TitleTile.tsx";
