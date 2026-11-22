/**
 * The billboard of each browse view: titles staff pin, in the order members see them, or none
 * (the recommendation engine chooses). Members see a change within the browse cache's lifetime.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BROWSE_VIEWS, type BrowseView, type EditorialBillboard } from "@webflix/contracts";
import { Button, EditIcon, Tabs, TabsContent, TabsList, TabsTrigger } from "@webflix/ui";
import { useEffect, useState } from "react";
import { staffApi } from "../../api/client.ts";
import { qk, queries } from "../../api/queries.ts";
import { ActionDialog } from "../../components/ActionDialog.tsx";
import { DateTime, PageHeader, Section } from "../../components/primitives.tsx";
import { Empty, ErrorPanel, LoadingRows } from "../../components/states.tsx";
import { useDocumentTitle } from "../../lib/hooks.ts";
import { VIEW_LABELS } from "../../lib/status.ts";
import { TitleListEditor, TitleRow, useTitles } from "./TitleListEditor.tsx";

const MAX_PINNED = 10;

export function BillboardsPage() {
  useDocumentTitle("Billboards");
  const [view, setView] = useState<BrowseView>("home");
  return (
    <>
      <PageHeader
        title="Billboards"
        description="The large feature at the top of each browse view. Pin titles to show them in this order; with none pinned, the recommendation engine chooses for each member."
      />
      <Tabs value={view} onValueChange={(next) => setView(next as BrowseView)}>
        <TabsList aria-label="Browse view" className="overflow-x-auto">
          {BROWSE_VIEWS.map((candidate) => (
            <TabsTrigger key={candidate} value={candidate}>
              {VIEW_LABELS[candidate]}
            </TabsTrigger>
          ))}
        </TabsList>
        {BROWSE_VIEWS.map((candidate) => (
          <TabsContent key={candidate} value={candidate}>
            {candidate === view ? <BillboardPanel view={candidate} /> : null}
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}

function BillboardPanel({ view }: { view: BrowseView }) {
  const billboard = useQuery(queries.billboard(view));
  const [open, setOpen] = useState(false);
  return (
    <Section
      title={`${VIEW_LABELS[view]} billboard`}
      description={
        billboard.data?.updatedAt ? (
          <>
            Last changed <DateTime value={billboard.data.updatedAt} />
          </>
        ) : undefined
      }
      actions={
        billboard.data ? (
          <Button size="sm" variant="outline" icon={EditIcon} onClick={() => setOpen(true)}>
            Change
          </Button>
        ) : null
      }
    >
      {billboard.isPending ? (
        <LoadingRows rows={3} label="Loading the billboard" />
      ) : billboard.isError ? (
        <ErrorPanel error={billboard.error} onRetry={() => void billboard.refetch()} />
      ) : billboard.data.titleIds.length === 0 ? (
        <Empty
          title="The engine chooses"
          description="No title is pinned: each member sees what the recommendation engine picks for them."
        />
      ) : (
        <PinnedList view={view} ids={billboard.data.titleIds} />
      )}
      {billboard.data ? (
        <BillboardDialog billboard={billboard.data} open={open} onOpenChange={setOpen} />
      ) : null}
    </Section>
  );
}

function PinnedList({ view, ids }: { view: BrowseView; ids: string[] }) {
  const titles = useTitles(ids);
  return (
    <ol className="flex flex-col gap-1" aria-label={`Pinned to the ${VIEW_LABELS[view]} billboard`}>
      {ids.map((id, index) => (
        <li key={id} className="flex items-center rounded-md bg-surface-2 px-2 py-1.5">
          <TitleRow
            id={id}
            title={titles.byId.get(id)}
            loading={titles.loading}
            position={index + 1}
          />
        </li>
      ))}
    </ol>
  );
}

function BillboardDialog({
  billboard,
  open,
  onOpenChange,
}: {
  billboard: EditorialBillboard;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [titleIds, setTitleIds] = useState(billboard.titleIds);
  // Each opening starts from what is pinned now.
  useEffect(() => {
    if (open) setTitleIds(billboard.titleIds);
  }, [open, billboard.titleIds]);
  const unchanged = titleIds.join(",") === billboard.titleIds.join(",");
  return (
    <ActionDialog<EditorialBillboard>
      open={open}
      onOpenChange={onOpenChange}
      scope={`billboard:${billboard.view}`}
      title={`Change the ${VIEW_LABELS[billboard.view]} billboard`}
      description="Members see these titles in this order. Leave it empty to let the engine choose."
      confirmLabel={titleIds.length === 0 ? "Let the engine choose" : "Save billboard"}
      size="lg"
      audit={{ targetType: "billboard", targetId: billboard.view }}
      validate={() => (unchanged ? "Nothing has changed yet." : null)}
      run={({ reason, signal, headers }) =>
        staffApi().setBillboard(
          { params: { view: billboard.view }, body: { titleIds, reason } },
          { signal, headers },
        )
      }
      onSuccess={(saved) => queryClient.setQueryData(qk.billboard(billboard.view), saved)}
      success={(saved) =>
        saved.titleIds.length === 0
          ? "No title is pinned now: the engine chooses for each member."
          : `${saved.titleIds.length} ${saved.titleIds.length === 1 ? "title is" : "titles are"} pinned, in the order shown. Members see the change within a few minutes.`
      }
    >
      <TitleListEditor value={titleIds} onChange={setTitleIds} max={MAX_PINNED} />
    </ActionDialog>
  );
}
