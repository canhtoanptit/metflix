import { Link } from "@tanstack/react-router";
import type { PersonRef, TitleDetail } from "@webflix/contracts";
import { ExternalLinkIcon, MaturityBadge } from "@webflix/ui";
import type { ReactNode } from "react";
import { languageName, maturityGuidance } from "../common/format.ts";

/** Everything else about the title: people, genres, moods, rating, languages and credits. */
export function AboutSection({ title }: { title: TitleDetail }) {
  const makers = title.type === "series" ? title.creators : title.directors;
  return (
    <section aria-labelledby="detail-about" className="mt-12">
      <h3 id="detail-about" className="type-title-lg text-fg">
        About <span className="font-extrabold">{title.name}</span>
      </h3>
      <dl className="mt-4 flex flex-col gap-2.5 type-body-sm">
        {makers.length > 0 ? (
          <Fact term={title.type === "series" ? "Creators" : "Director"}>
            <People people={makers} />
          </Fact>
        ) : null}
        {title.cast.length > 0 ? (
          <Fact term="Cast">
            <People people={title.cast} />
          </Fact>
        ) : null}
        {title.writers.length > 0 ? (
          <Fact term="Writers">
            <People people={title.writers} />
          </Fact>
        ) : null}
        <Fact term="Genres">
          {title.genres.map((genre, index) => (
            <span key={genre.slug}>
              {index > 0 ? ", " : null}
              <Link
                to="/browse/genre/$slug"
                params={{ slug: genre.slug }}
                search={{}}
                className="focus-ring rounded-xs underline-offset-4 hover:underline"
              >
                {genre.name}
              </Link>
            </span>
          ))}
        </Fact>
        {title.moods.length > 0 ? <Fact term="This title is">{title.moods.join(", ")}</Fact> : null}
        <Fact term="Maturity rating">
          <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 align-middle">
            <MaturityBadge rating={title.maturity} descriptors={title.maturityDescriptors} />
            <span className="text-fg-muted">{maturityGuidance(title.maturity)}</span>
          </span>
        </Fact>
        {title.audioLanguages.length > 0 ? (
          <Fact term="Audio">{title.audioLanguages.map(languageName).join(", ")}</Fact>
        ) : null}
        {title.subtitleLanguages.length > 0 ? (
          <Fact term="Subtitles">{title.subtitleLanguages.map(languageName).join(", ")}</Fact>
        ) : null}
        {title.attribution ? (
          <Fact term="Credits">
            <span>{title.attribution.text}. </span>
            <a
              href={title.attribution.licenseUrl}
              target="_blank"
              rel="noreferrer"
              className="focus-ring inline-flex items-center gap-1 rounded-xs underline underline-offset-4 hover:text-fg"
            >
              {title.attribution.license}
              <ExternalLinkIcon size="xs" label="opens in a new tab" />
            </a>
            {title.attribution.sourceUrl ? (
              <>
                {" · "}
                <a
                  href={title.attribution.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="focus-ring inline-flex items-center gap-1 rounded-xs underline underline-offset-4 hover:text-fg"
                >
                  Source
                  <ExternalLinkIcon size="xs" label="opens in a new tab" />
                </a>
              </>
            ) : null}
          </Fact>
        ) : null}
      </dl>
    </section>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt className="inline text-fg-subtle">{term}: </dt>
      <dd className="inline text-fg">{children}</dd>
    </div>
  );
}

function People({ people }: { people: readonly PersonRef[] }) {
  return <>{people.map((person) => person.name).join(", ")}</>;
}
