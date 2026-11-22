/**
 * Create or change a curated collection. The form validates as the contract does before
 * anything is sent; saving asks why (audited) and says when members will see it.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { BROWSE_VIEWS, type BrowseView, type EditorialCollection } from "@webflix/contracts";
import {
  Button,
  ChevronLeftIcon,
  EmptyState,
  Field,
  Input,
  RadioGroup,
  RadioItem,
  Select,
  SelectItem,
  Textarea,
} from "@webflix/ui";
import { useId, useState } from "react";
import { staffApi } from "../../api/client.ts";
import { qk, queries } from "../../api/queries.ts";
import { ActionDialog } from "../../components/ActionDialog.tsx";
import { PageHeader, Section } from "../../components/primitives.tsx";
import { ErrorPanel, LoadingPage } from "../../components/states.tsx";
import { useDocumentTitle } from "../../lib/hooks.ts";
import { VIEW_LABELS } from "../../lib/status.ts";
import { TitleListEditor } from "./TitleListEditor.tsx";

interface Draft {
  name: string;
  description: string;
  view: BrowseView;
  position: string;
  titleIds: string[];
  status: "draft" | "published";
}

type Errors = Partial<Record<"name" | "description" | "position" | "titleIds", string>>;

export function validateCollection(draft: Draft): Errors {
  const errors: Errors = {};
  const name = draft.name.trim();
  if (name.length === 0) errors.name = "Give the row a name members will see.";
  else if (name.length > 80) errors.name = `Keep the name to 80 characters (${name.length} now).`;
  if (draft.description.length > 500) {
    errors.description = `Keep the description to 500 characters (${draft.description.length} now).`;
  }
  const position = Number(draft.position);
  if (!/^\d{1,2}$/.test(draft.position.trim()) || position < 1 || position > 50) {
    errors.position = "A row number from 1 (top) to 50.";
  }
  if (draft.titleIds.length === 0) errors.titleIds = "Add at least one title.";
  else if (draft.titleIds.length > 40) errors.titleIds = "At most 40 titles.";
  return errors;
}

function fromCollection(collection: EditorialCollection): Draft {
  return {
    name: collection.name,
    description: collection.description ?? "",
    view: collection.view,
    position: String(collection.position),
    titleIds: [...collection.titleIds],
    status: collection.status,
  };
}

const EMPTY: Draft = {
  name: "",
  description: "",
  view: "home",
  position: "3",
  titleIds: [],
  status: "draft",
};

export function NewCollectionPage() {
  useDocumentTitle("New collection");
  return <CollectionEditor initial={EMPTY} collection={null} />;
}

const editRoute = getRouteApi("/content/collections/$id");

export function EditCollectionPage() {
  useDocumentTitle("Edit collection");
  const { id } = editRoute.useParams();
  const collections = useQuery(queries.collections());
  if (collections.isPending) return <LoadingPage label="Loading the collection" />;
  if (collections.isError) {
    return (
      <ErrorPanel
        layout="page"
        error={collections.error}
        onRetry={() => void collections.refetch()}
      />
    );
  }
  const collection = collections.data.items.find((item) => item.id === id);
  if (!collection) {
    return (
      <EmptyState
        layout="page"
        title="No such collection"
        description="It may have been deleted. The list shows every collection there is."
        action={
          <Button asChild variant="outline" size="sm">
            <Link to="/content/collections">All collections</Link>
          </Button>
        }
      />
    );
  }
  return (
    <CollectionEditor
      key={collection.id}
      initial={fromCollection(collection)}
      collection={collection}
    />
  );
}

function CollectionEditor({
  initial,
  collection,
}: {
  initial: Draft;
  collection: EditorialCollection | null;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [draft, setDraft] = useState(initial);
  const [errors, setErrors] = useState<Errors>({});
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const statusId = useId();
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };
  const body = {
    name: draft.name.trim(),
    description: draft.description.trim() ? draft.description.trim() : null,
    view: draft.view,
    position: Number(draft.position),
    titleIds: draft.titleIds,
    status: draft.status,
  };

  return (
    <>
      <Link
        to="/content/collections"
        className="focus-ring mb-3 inline-flex items-center gap-1 rounded-xs type-body-sm text-fg-muted hover:text-fg"
      >
        <ChevronLeftIcon size="sm" />
        Collections
      </Link>
      <PageHeader
        title={collection ? collection.name : "New collection"}
        description="A curated row on one browse view. Members whose profile can't see a title don't get it in the row."
      />
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          const found = validateCollection(draft);
          setErrors(found);
          if (Object.values(found).some(Boolean)) return;
          setOpen(true);
        }}
      >
        <div className="grid items-start gap-4 xl:grid-cols-2">
          <Section title="The row">
            <div className="flex flex-col gap-4">
              <Field label="Name" required error={errors.name} hint="Shown as the row title.">
                <Input
                  size="sm"
                  value={draft.name}
                  maxLength={120}
                  onChange={(event) => set("name", event.target.value)}
                />
              </Field>
              <Field label="Description" error={errors.description} hint="For staff; optional.">
                <Textarea
                  size="sm"
                  rows={2}
                  value={draft.description}
                  onChange={(event) => set("description", event.target.value)}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="View">
                  <Select
                    variant="compact"
                    value={draft.view}
                    onValueChange={(value) => set("view", value as BrowseView)}
                  >
                    {BROWSE_VIEWS.map((view) => (
                      <SelectItem key={view} value={view}>
                        {VIEW_LABELS[view]}
                      </SelectItem>
                    ))}
                  </Select>
                </Field>
                <Field label="Row position" error={errors.position} hint="1 is the top row.">
                  <Input
                    size="sm"
                    type="number"
                    min={1}
                    max={50}
                    inputMode="numeric"
                    value={draft.position}
                    onChange={(event) => set("position", event.target.value)}
                  />
                </Field>
              </div>
              <fieldset>
                <legend id={statusId} className="mb-2 type-label text-fg">
                  Status
                </legend>
                <RadioGroup
                  aria-labelledby={statusId}
                  value={draft.status}
                  onValueChange={(value) => set("status", value as Draft["status"])}
                  className="flex flex-col gap-2"
                >
                  <RadioItem
                    value="draft"
                    label="Draft"
                    description="Saved, not shown to members."
                  />
                  <RadioItem
                    value="published"
                    label="Published"
                    description="Shown to members within a few minutes."
                  />
                </RadioGroup>
              </fieldset>
            </div>
          </Section>
          <Section title="Titles">
            <TitleListEditor
              value={draft.titleIds}
              onChange={(next) => set("titleIds", next)}
              max={40}
              error={errors.titleIds}
            />
          </Section>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/content/collections">Cancel</Link>
          </Button>
          <Button type="submit" variant="accent" size="sm">
            {collection
              ? "Save changes"
              : draft.status === "published"
                ? "Publish collection"
                : "Save draft"}
          </Button>
        </div>
      </form>
      <ActionDialog<EditorialCollection>
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // A new collection continues on its own page once its outcome has been seen.
          if (!next && created)
            void navigate({
              to: "/content/collections/$id",
              params: { id: created },
              replace: true,
            });
        }}
        scope={`collection:${collection?.id ?? "new"}`}
        title={
          collection
            ? `Save “${body.name}”`
            : draft.status === "published"
              ? `Publish “${body.name}”`
              : `Save “${body.name}” as a draft`
        }
        description={
          draft.status === "published"
            ? `${VIEW_LABELS[draft.view]}, row ${draft.position}, ${draft.titleIds.length} ${draft.titleIds.length === 1 ? "title" : "titles"}. Members see it within a few minutes.`
            : "Saved as a draft: members don't see it."
        }
        confirmLabel={draft.status === "published" ? "Publish" : "Save"}
        audit={collection ? { targetType: "collection", targetId: collection.id } : undefined}
        run={({ reason, signal, headers }) =>
          collection
            ? staffApi().updateCollection(
                { params: { id: collection.id }, body: { ...body, reason } },
                { signal, headers },
              )
            : staffApi().createCollection({ body: { ...body, reason } }, { signal, headers })
        }
        onSuccess={(saved) => {
          void queryClient.invalidateQueries({ queryKey: qk.collections() });
          if (!collection) setCreated(saved.id);
        }}
        success={(saved) =>
          saved.status === "published"
            ? `“${saved.name}” is published on ${VIEW_LABELS[saved.view]} at row ${saved.position}.`
            : `“${saved.name}” is saved as a draft.`
        }
      />
    </>
  );
}
