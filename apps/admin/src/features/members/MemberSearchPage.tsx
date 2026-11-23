/**
 * Find a member by email (or its beginning) or account id. A search is sent when asked for,
 * never as you type: every search is recorded in the audit log with its query.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { MemberSummary } from "@webflix/contracts";
import { Badge, Button, EmailText, Field, Input, SearchIcon } from "@webflix/ui";
import { useState } from "react";
import { queries } from "../../api/queries.ts";
import { type Column, DataTable } from "../../components/DataTable.tsx";
import { DateOnly, Identifier, PageHeader, StatusBadge } from "../../components/primitives.tsx";
import { Empty, ErrorPanel, LoadingRows } from "../../components/states.tsx";
import { useDocumentTitle } from "../../lib/hooks.ts";
import { MEMBERSHIP, planName } from "../../lib/status.ts";
import { memberSearch, useMemberSearch } from "./search-store.ts";

const columns: Column<MemberSummary>[] = [
  {
    id: "email",
    header: "Email",
    cell: (member) => (
      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Link
          to="/members/$accountId"
          params={{ accountId: member.accountId }}
          className="focus-ring rounded-xs font-semibold text-fg underline-offset-4 hover:underline"
        >
          <EmailText tone="inherit">{member.email}</EmailText>
        </Link>
        {member.isDemo ? (
          <Badge tone="info" size="sm">
            Demo
          </Badge>
        ) : null}
        {/* On phones the membership rides under the address instead of in its own column. */}
        <span className="flex w-full items-center gap-2 sm:hidden">
          <StatusBadge tone={MEMBERSHIP[member.membershipStatus].tone}>
            {MEMBERSHIP[member.membershipStatus].label}
          </StatusBadge>
          {member.planId ? (
            <span className="type-caption text-fg-muted">{planName(member.planId)}</span>
          ) : null}
        </span>
      </span>
    ),
  },
  {
    id: "membership",
    header: "Membership",
    hideBelow: "sm",
    cell: (member) => (
      <span className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={MEMBERSHIP[member.membershipStatus].tone}>
          {MEMBERSHIP[member.membershipStatus].label}
        </StatusBadge>
        {member.planId ? <span className="text-fg-muted">{planName(member.planId)}</span> : null}
      </span>
    ),
  },
  {
    id: "joined",
    header: "Joined",
    hideBelow: "md",
    cell: (member) => <DateOnly value={member.createdAt} />,
  },
  {
    id: "account",
    header: "Account ID",
    hideBelow: "lg",
    cell: (member) => <Identifier value={member.accountId} label="account ID" truncate />,
  },
];

export function MemberSearchPage() {
  useDocumentTitle("Members");
  const search = useMemberSearch();
  const [draft, setDraft] = useState(search.q);
  const [error, setError] = useState<string | null>(null);
  const cursor = search.cursors.at(-1) ?? null;
  const results = useQuery({
    ...queries.memberSearch(search.q, cursor),
    enabled: search.q.length > 0,
    // Paging keeps the current page on screen until the next arrives; a new query never shows
    // the previous query's results.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3] === search.q ? previous : undefined,
  });

  return (
    <>
      <PageHeader
        title="Members"
        description="Find a member by email address (or its beginning) or by account ID. Each search is recorded in the audit log."
      />
      <search aria-label="Members">
        <form
          noValidate
          className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start"
          onSubmit={(event) => {
            event.preventDefault();
            const q = draft.trim();
            if (q.length === 0) {
              setError("Enter an email address, the beginning of one, or an account ID.");
              return;
            }
            if (q.length > 254) {
              setError("That's longer than any email address (254 characters at most).");
              return;
            }
            setError(null);
            memberSearch.search(q);
          }}
        >
          <Field
            label="Email or account ID"
            hideLabel
            error={error ?? undefined}
            className="sm:flex-1"
          >
            <Input
              size="sm"
              type="search"
              inputMode="email"
              autoComplete="off"
              spellCheck={false}
              placeholder="Email address or account ID"
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                if (error) setError(null);
              }}
            />
          </Field>
          <Button type="submit" variant="accent" size="sm" icon={SearchIcon} className="h-9">
            Search
          </Button>
        </form>
      </search>

      {search.q.length === 0 ? (
        <Empty
          title="Search for a member"
          description="Start with their email address. An account ID (from a ticket or the audit log) finds exactly one member."
        />
      ) : results.isPending ? (
        <LoadingRows rows={5} label="Searching" />
      ) : results.isError ? (
        <ErrorPanel error={results.error} onRetry={() => void results.refetch()} />
      ) : (
        <DataTable
          caption={`Members matching “${search.q}”, in the order the service returns them`}
          showCaption
          columns={columns}
          rows={results.data.items}
          rowKey={(member) => member.accountId}
          empty={
            <Empty
              title="No member matches"
              description={`Nothing matches “${search.q}”. Check the spelling, try the beginning of the address, or search by account ID.`}
            />
          }
          pager={
            search.cursors.length > 1 || results.data.nextCursor
              ? {
                  label: `Page ${search.cursors.length}`,
                  hasPrevious: search.cursors.length > 1,
                  hasNext: results.data.nextCursor !== null,
                  loading: results.isFetching,
                  onPrevious: () => memberSearch.previous(),
                  onNext: () => {
                    if (results.data.nextCursor) memberSearch.next(results.data.nextCursor);
                  },
                }
              : undefined
          }
        />
      )}
    </>
  );
}
