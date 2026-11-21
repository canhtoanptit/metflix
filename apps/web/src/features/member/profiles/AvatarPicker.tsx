import { useQuery } from "@tanstack/react-query";
import type { Avatar as AvatarDto } from "@webflix/contracts";
import {
  Avatar,
  Button,
  CheckIcon,
  cx,
  Dialog,
  DialogContent,
  DialogFooter,
  ErrorState,
  Skeleton,
} from "@webflix/ui";
import { RadioGroup } from "radix-ui";
import { useState } from "react";
import { describeError } from "../../../app/query/errors.ts";
import { queries } from "../../../app/query/queries.ts";

/**
 * Picture picker: the avatar catalog by group, as one radio group (arrow keys move and select),
 * with the choice previewed at the top and confirmed explicitly.
 */
export function AvatarPicker({
  open,
  onOpenChange,
  current,
  name,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: AvatarDto | null;
  name: string;
  onChoose: (avatar: AvatarDto) => void;
}) {
  const avatars = useQuery({ ...queries.avatars(), enabled: open });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const all = avatars.data?.groups.flatMap((group) => group.avatars) ?? [];
  const selected = all.find((avatar) => avatar.id === (selectedId ?? current?.id)) ?? current;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setSelectedId(null);
        onOpenChange(next);
      }}
    >
      <DialogContent title="Choose a profile picture" size="lg">
        <div className="mb-6 flex items-center gap-4">
          <Avatar src={selected?.imageUrl} name={name || "Profile"} size="lg" decorative />
          <div className="flex flex-col">
            <span className="type-label text-fg">{name || "New profile"}</span>
            <span className="type-body-sm text-fg-muted">{selected?.name ?? "No picture yet"}</span>
          </div>
        </div>
        {avatars.isPending ? (
          <div className="grid grid-cols-4 gap-3 sm:grid-cols-6">
            {Array.from({ length: 12 }, (_, index) => (
              <Skeleton key={index} aspectRatio={1} radius="md" />
            ))}
          </div>
        ) : avatars.isError ? (
          <ErrorState
            title="Pictures didn't load"
            description={describeError(avatars.error).description}
            action={
              <Button variant="primary" onClick={() => void avatars.refetch()}>
                Try again
              </Button>
            }
          />
        ) : (
          <RadioGroup.Root
            aria-label="Profile pictures"
            value={selected?.id}
            onValueChange={setSelectedId}
            className="flex max-h-[50dvh] flex-col gap-6 overflow-y-auto pe-1"
          >
            {avatars.data.groups.map((group) => (
              <section key={group.id} aria-labelledby={`avatar-group-${group.id}`}>
                <h3 id={`avatar-group-${group.id}`} className="mb-3 type-label text-fg-muted">
                  {group.name}
                </h3>
                <div className="grid grid-cols-4 gap-3 sm:grid-cols-6">
                  {group.avatars.map((avatar) => (
                    <RadioGroup.Item
                      key={avatar.id}
                      value={avatar.id}
                      aria-label={avatar.name}
                      className={cx(
                        "group focus-ring relative aspect-square w-full rounded-avatar text-2xl ring-0 ring-fg transition-[box-shadow] duration-fast",
                        "hover:ring-2 data-[state=checked]:ring-4 data-[state=checked]:ring-accent",
                      )}
                    >
                      <Avatar src={avatar.imageUrl} name={avatar.name} size="fill" decorative />
                      <RadioGroup.Indicator className="absolute end-1 top-1 grid size-6 place-items-center rounded-full bg-accent text-fg-on-accent shadow-sm">
                        <CheckIcon size="xs" strokeWidth={3} />
                      </RadioGroup.Indicator>
                    </RadioGroup.Item>
                  ))}
                </div>
              </section>
            ))}
          </RadioGroup.Root>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="accent"
            disabled={!selected}
            onClick={() => {
              if (selected) onChoose(selected);
              onOpenChange(false);
            }}
          >
            Use this picture
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
