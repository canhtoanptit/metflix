/** Curated collections: editorial rows on a browse view, drafted and published by staff. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { EditorialCollection } from "@webflix/contracts";
import { Button, EditIcon, PlusIcon, TrashIcon } from "@webflix/ui";
import { useState } from "react";
import { staffApi } from "../../api/client.ts";
import { qk, queries } from "../../api/queries.ts";
import { ActionDialog } from "../../components/ActionDialog.tsx";
import { type Column, DataTable } from "../../components/DataTable.tsx";
import { DateTime, PageHeader, Section, StatusBadge } from "../../components/primitives.tsx";
import { Empty, ErrorPanel, LoadingRows } from "../../components/states.tsx";
import { useDocumentTitle } from "../../lib/hooks.ts";
import { VIEW_LABELS } from "../../lib/status.ts";

export function CollectionsPage() {
  useDocumentTitle("Collections");
  const collections = useQuery(queries.collections());
  const [deleting, setDeleting] = useState<EditorialCollection | null>(null);
  const [open, setOpen] = useState(false);

  const columns: Column<EditorialCollection>[] = [
    {
      id: "name",
      header: "Name",
      sortValue: (row) => row.name.toLowerCase(),
      cell: (row) => (
        <Link
          to="/content/collections/$id"
          params={{ id: row.id }}
          className="focus-ring rounded-xs font-semibold text-fg underline-offset-4 hover:underline"
        >
          {row.name}
        </Link>
      ),
    },
    {
      id: "status",
      header: "Status",
      sortValue: (row) => row.status,
      cell: (row) => (
        <StatusBadge tone={row.status === "published" ? "positive" : "outline"}>
          {row.status === "published" ? "Published" : "Draft"}
        </StatusBadge>
      ),
    },
    {
      id: "placement",
      header: "Where",
      sortValue: (row) => `${row.view}:${String(row.position).padStart(2, "0")}`,
      cell: (row) => `${VIEW_LABELS[row.view]}, row ${row.position}`,
    },
    {
      id: "titles",
      header: "Titles",
      align: "end",
      hideBelow: "sm",
      sortValue: (row) => row.titleIds.length,
      cell: (row) => row.titleIds.length,
    },
    {
      id: "updated",
      header: "Changed",
      hideBelow: "md",
      sortValue: (row) => row.updatedAt,
      cell: (row) => <DateTime value={row.updatedAt} />,
    },
    {
      id: "actions",
      header: <span className="sr-only">Actions</span>,
      align: "end",
      cell: (row) => (
        <span className="inline-flex gap-1">
          <Button asChild size="sm" variant="ghost" icon={EditIcon}>
            <Link
              to="/content/collections/$id"
              params={{ id: row.id }}
              aria-label={`Edit ${row.name}`}
            >
              Edit
            </Link>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={TrashIcon}
            aria-label={`Delete ${row.name}`}
            onClick={() => {
              setDeleting(row);
              setOpen(true);
            }}
          >
            Delete
          </Button>
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Collections"
        description="Curated rows. A published collection appears on its view at its row position, for every member whose profile can see its titles."
        actions={
          <Button asChild variant="accent" size="sm" icon={PlusIcon}>
            <Link to="/content/collections/new">New collection</Link>
          </Button>
        }
      />
      <Section title="All collections">
        {collections.isPending ? (
          <LoadingRows rows={4} label="Loading collections" />
        ) : collections.isError ? (
          <ErrorPanel error={collections.error} onRetry={() => void collections.refetch()} />
        ) : (
          <DataTable
            caption="Curated collections"
            columns={columns}
            rows={collections.data.items}
            rowKey={(row) => row.id}
            initialSort={{ column: "placement", direction: "asc" }}
            pageSize={25}
            empty={
              <Empty
                title="No collections yet"
                description="Create one to put a curated row on a browse view."
                action={
                  <Button asChild variant="outline" size="sm" icon={PlusIcon}>
                    <Link to="/content/collections/new">New collection</Link>
                  </Button>
                }
              />
            }
          />
        )}
      </Section>
      {deleting ? (
        <DeleteCollectionDialog
          key={deleting.id}
          collection={deleting}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}

function DeleteCollectionDialog({
  collection,
  open,
  onOpenChange,
}: {
  collection: EditorialCollection;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  return (
    <ActionDialog
      open={open}
      onOpenChange={onOpenChange}
      scope={`collection-delete:${collection.id}`}
      title={`Delete “${collection.name}”`}
      description={
        collection.status === "published"
          ? `It disappears from ${VIEW_LABELS[collection.view]} for every member within a few minutes. This can't be undone.`
          : "This draft is removed. This can't be undone."
      }
      confirmLabel="Delete collection"
      tone="danger"
      audit={{ targetType: "collection", targetId: collection.id }}
      run={({ reason, signal, headers }) =>
        staffApi().deleteCollection(
          { params: { id: collection.id }, body: { reason } },
          { signal, headers },
        )
      }
      onSuccess={() => void queryClient.invalidateQueries({ queryKey: qk.collections() })}
      success={() => `“${collection.name}” is deleted.`}
    />
  );
}
