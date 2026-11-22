"""How simulated members behave: sessions, browsing, clicks, watching, lists, ratings, churn.

One `Household` per account, simulated day by day. Everything random comes from the account's
own generator (seeded by the run seed and the account index), so a run is identical whatever
the sharding or the number of worker processes.

Behavioural model, per app session:

* A time budget (log-normal, median 45 min) and a home page from the logging policy.
* Continue Watching first: the member resumes the most recent title with a probability that
  grows with its utility (and is small if they gave up on it).
* Otherwise they scan modules top-down, continuing to the next with their patience
  probability. On a module that is on screen, the card at 1-based position k is examined with
  probability `k^-0.7 x attention(row)` (`world.examine_probability`, `world.row_attention`);
  only the first 6 cards are visible unless they scroll the row (12%).
* An examined card is clicked with `sigmoid(2.2 (U_dyn - 2.0))`, where the dynamic utility adds
  a novelty boost for recently added titles and subtracts fatigue from repeated impressions
  without a click and penalties for titles finished or abandoned.
* A planted experiment effect multiplies the treatment profiles' session rate by 1 + effect.
* A click opens the title; the member plays it with `sigmoid(1.5 (U - 0.5))` (clipped), watches
  to completion with a probability that grows with utility, or stops after a Beta-distributed
  fraction (and drops the title). Budget runs out mid-title: they resume another day.
  Series play episode by episode with autoplay bingeing. 4% of plays are accidental samples.
* Searches (7% of sessions) go straight to a title the member wants, outside the rows.
* Account satisfaction (an average of how much they liked what they watched) drives the daily
  churn hazard. Kids profiles produce server playback events only.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np
import numpy.typing as npt

from webflix_recs import schemas as ev
from webflix_recs.catalog import Catalog
from webflix_recs.ids import DAY_MS, HOUR_MS, pseudonym
from webflix_recs.simulate.config import SimConfig
from webflix_recs.simulate.emit import AppSession, Device, Emitter, Subject, context
from webflix_recs.simulate.policy import Library, Module, Policy, Progress
from webflix_recs.simulate.world import (
    ProfileTruth,
    TitleTruth,
    examine_probability,
    make_household,
    row_attention,
)

COUNTRIES = ("US", "GB", "DE", "FR", "BR", "VN", "IN", "CA")
COUNTRY_P = (0.45, 0.15, 0.10, 0.08, 0.07, 0.05, 0.05, 0.05)
PLANS = ("basic", "standard", "premium")
PLAN_P = (0.30, 0.45, 0.25)
# Session start hour (UTC is the members' local time here): evening peak.
HOUR_P = np.array(
    [
        1,
        0.5,
        0.3,
        0.2,
        0.2,
        0.3,
        0.8,
        1.2,
        1.4,
        1.4,
        1.5,
        1.8,
        2.2,
        2.2,
        2.0,
        2.0,
        2.4,
        3.2,
        4.6,
        6.2,
        7.0,
        6.4,
        4.4,
        2.2,
    ]
)
HOUR_P = HOUR_P / HOUR_P.sum()
VISIBLE_CARDS = 6
SCROLLED_CARDS = 12
COMPLETION_RATIO = 0.95
MIN_COUNTED_SEC = 30.0
TRIAL_DAYS = 7


def sigmoid(x: Any) -> Any:
    return 1.0 / (1.0 + np.exp(-x))


@dataclass(slots=True)
class ProfileSim:
    truth: ProfileTruth
    internal_id: str
    key: str
    utility: npt.NDArray[np.float64]
    created_ms: int
    device: Device
    assignments: dict[str, str]
    library: Library = field(default_factory=Library)
    fatigue: npt.NDArray[np.float64] = field(default_factory=lambda: np.zeros(0))
    fatigue_day: int = 0
    sessions: int = 0
    plays: int = 0


@dataclass(slots=True)
class Household:
    index: int
    internal_id: str
    key: str
    rng: np.random.Generator
    profiles: list[ProfileSim]
    join_ms: int
    existing: bool
    plan: str
    country: str
    state: str
    trial_end_ms: int | None
    churned_ms: int | None
    analytics: bool
    personalisation: bool
    consent_change_ms: int | None
    tv: Device | None
    satisfaction: float = 0.5
    signup_done: bool = False

    def personalisation_at(self, at_ms: int) -> bool:
        if self.consent_change_ms is not None and at_ms >= self.consent_change_ms:
            return not self.personalisation
        return self.personalisation


@dataclass(slots=True)
class ShardStats:
    sessions: int = 0
    plays: int = 0
    clicks: int = 0
    impressions_shown: int = 0
    searches: int = 0
    signups: int = 0
    churned: int = 0


class World:
    """Everything shared by the households of one shard."""

    def __init__(
        self,
        config: SimConfig,
        catalog: Catalog,
        titles: TitleTruth,
        policy: Policy,
        emitter: Emitter,
        people: tuple[tuple[str, ...], npt.NDArray[np.float64]],
    ) -> None:
        self.config = config
        self.catalog = catalog
        self.titles = titles
        self.policy = policy
        self.emit = emitter
        self.people = people
        self.key = config.pseudonym_key.encode()
        self.stats = ShardStats()
        self.ids = catalog.ids
        self.durations = [
            [float(e.runtime_sec) for e in t.episodes]
            if t.is_series
            else [float(t.runtime_sec or 1)]
            for t in catalog.titles
        ]
        self.episode_ids = [[e.id for e in t.episodes] for t in catalog.titles]

    # --- households ---------------------------------------------------------------------------

    def make_household(self, index: int) -> Household:
        from webflix_recs.simulate.world import utility_matrix  # noqa: PLC0415

        config = self.config
        rng = np.random.default_rng([config.seed, 1, index])
        internal = f"sim-account-{index}"
        existing = rng.random() < config.existing_share
        if existing:
            join_ms = (
                config.start_ms - int(rng.integers(1, 400)) * DAY_MS - int(rng.integers(0, DAY_MS))
            )
        else:
            join_ms = config.start_ms + int(rng.integers(0, config.days * DAY_MS))
        truths = make_household(self.catalog, index, rng, *self.people)
        utility = utility_matrix(self.catalog, self.titles, truths, config.seed)
        tv = None
        if len(truths) > 1 and rng.random() < 0.6:
            tv = self._device(rng, "tv")
        profiles = []
        for row, truth in enumerate(truths):
            profile_internal = f"{internal}-profile-{truth.number}"
            key = pseudonym(self.key, "profile", profile_internal)
            assignments = (
                {} if truth.restricted else {e.key: e.assign(key) for e in config.experiments}
            )
            platform = str(rng.choice(["web", "ios", "android"], p=[0.5, 0.3, 0.2]))
            profiles.append(
                ProfileSim(
                    truth=truth,
                    internal_id=profile_internal,
                    key=key,
                    utility=utility[row],
                    created_ms=join_ms + truth.created_offset_days * DAY_MS,
                    device=self._device(rng, platform),
                    assignments=assignments,
                    fatigue=np.zeros(len(self.catalog)),
                    fatigue_day=0,
                )
            )
        consent_change = None
        if rng.random() < config.consent_change_rate:
            consent_change = max(join_ms, config.start_ms) + int(
                rng.integers(DAY_MS, max(2 * DAY_MS, config.days * DAY_MS))
            )
        return Household(
            index=index,
            internal_id=internal,
            key=pseudonym(self.key, "account", internal),
            rng=rng,
            profiles=profiles,
            join_ms=join_ms,
            existing=existing,
            plan=str(rng.choice(PLANS, p=PLAN_P)),
            country=str(rng.choice(COUNTRIES, p=COUNTRY_P)),
            state="active" if existing else "none",
            trial_end_ms=None,
            churned_ms=None,
            analytics=bool(rng.random() >= config.analytics_decline_rate),
            personalisation=bool(rng.random() >= config.personalisation_decline_rate),
            consent_change_ms=consent_change,
            tv=tv,
        )

    def _device(self, rng: np.random.Generator, platform: str) -> Device:
        if rng.random() < self.config.skewed_device_rate:
            skew = int(rng.choice([-1, 1]) * rng.integers(5 * 60_000, 6 * HOUR_MS))
        else:
            skew = int(rng.normal(0, 1500))
        return Device(id=f"d{rng.integers(0, 2**63):016x}", platform=platform, skew_ms=skew)

    def subject(self, household: Household, profile: ProfileSim | None, at_ms: int) -> Subject:
        return Subject(
            account=household.key if household.signup_done or household.existing else None,
            profile=profile.key if profile is not None else None,
            plan=household.plan,
            country=household.country,
            restricted=profile.truth.restricted if profile is not None else False,
            analytics=household.analytics,
            personalisation=household.personalisation_at(at_ms),
        )

    # --- one day ------------------------------------------------------------------------------

    def simulate_day(self, household: Household, day: int) -> None:
        config = self.config
        rng = household.rng
        day_ms = config.start_ms + day * DAY_MS
        day_end = day_ms + DAY_MS
        if household.churned_ms is not None or household.join_ms >= day_end:
            return
        if not household.existing and not household.signup_done:
            self._signup(household, household.join_ms)
        if (
            household.state == "trialing"
            and household.trial_end_ms is not None
            and household.trial_end_ms < day_end
        ):
            self._billing(household, household.trial_end_ms, "trialing", "active")
        change = household.consent_change_ms
        if change is not None and day_ms <= change < day_end and change >= household.join_ms:
            # Consent is the account's; the event carries the new state in its stamp.
            subject = self.subject(household, None, change)
            self.emit.server(
                ev.CONSENT_CHANGE, change, subject, context(),
                {
                    "purpose": "personalisation",
                    "granted": subject.personalisation,
                    "source": "settings",
                },
            )  # fmt: skip
        weekday = (day_ms // DAY_MS + 4) % 7  # 1970-01-01 was a Thursday
        weekend = 1.3 if weekday in (5, 6) else 1.0
        engagement = float(np.clip(0.55 + household.satisfaction, 0.5, 1.4))
        starts: list[tuple[int, int]] = []
        for number, profile in enumerate(household.profiles):
            if profile.created_ms >= day_end:
                continue
            rate = (
                config.activity
                * profile.truth.activity
                * weekend
                * engagement
                * self._treatment_effect(profile)
            )
            for _ in range(int(rng.poisson(rate))):
                hour = int(rng.choice(24, p=HOUR_P))
                start = day_ms + hour * HOUR_MS + int(rng.integers(0, HOUR_MS))
                if start > max(profile.created_ms, household.join_ms) + 10 * 60_000:
                    starts.append((start, number))
        for start, number in sorted(starts):
            self._session(household, household.profiles[number], start)
        hazard = (
            0.0022
            * np.exp(-2.2 * (household.satisfaction - 0.45))
            * (2.0 if household.state == "trialing" else 1.0)
        )
        if rng.random() < hazard:
            household.churned_ms = day_end - 1
            self._billing(household, day_end - 1, household.state, "canceled")
            self.stats.churned += 1

    def _treatment_effect(self, profile: ProfileSim) -> float:
        """A planted experiment effect: treatment profiles come back `1 + effect` times as often
        (so qualified plays per member, the registered primary metric, move by about that)."""
        factor = 1.0
        for spec in self.config.experiments:
            if profile.assignments.get(spec.key) == spec.treatment:
                factor *= 1.0 + spec.effect
        return factor

    def _signup(self, household: Household, at_ms: int) -> None:
        owner = household.profiles[0]
        rng = household.rng
        session = AppSession(device=owner.device)
        anonymous = self.subject(household, None, at_ms)
        ctx = context(surface="signup")
        t = at_ms
        if household.analytics or household.personalisation:
            self.emit.client(
                ev.SIGNUP_STEP, t, session, anonymous, ctx, {"step": "email", "outcome": "viewed"}
            )
            t += int(rng.integers(5_000, 40_000))
            self.emit.client(
                ev.SIGNUP_STEP,
                t,
                session,
                anonymous,
                ctx,
                {"step": "email", "outcome": "completed"},
            )
        t += int(rng.integers(5_000, 60_000))
        household.signup_done = True
        signed = self.subject(household, None, t)
        self.emit.server(
            ev.AUTH_SIGNUP,
            t,
            signed,
            context(),
            {"method": str(rng.choice(["password", "oidc"])), "outcome": "success"},
        )
        t += int(rng.integers(10_000, 120_000))
        if household.analytics or household.personalisation:
            self.emit.client(
                ev.SIGNUP_STEP, t, session, signed, ctx, {"step": "plan", "outcome": "completed"}
            )
            t += int(rng.integers(20_000, 120_000))
            self.emit.client(
                ev.SIGNUP_STEP, t, session, signed, ctx, {"step": "payment", "outcome": "completed"}
            )
        household.state = "none"
        self._billing(household, t + 2_000, "none", "trialing")
        household.trial_end_ms = t + TRIAL_DAYS * DAY_MS
        if household.analytics or household.personalisation:
            t += int(rng.integers(20_000, 90_000))
            self.emit.client(
                ev.SIGNUP_STEP,
                t,
                session,
                signed,
                ctx,
                {"step": "profiles", "outcome": "completed"},
            )
            self.emit.client(
                ev.SIGNUP_STEP,
                t + 500,
                session,
                signed,
                ctx,
                {"step": "complete", "outcome": "completed"},
            )
        self.stats.signups += 1

    def _billing(self, household: Household, at_ms: int, before: str, after: str) -> None:
        household.state = after
        subject = self.subject(household, None, at_ms)
        self.emit.server(
            ev.BILLING_TRANSITION,
            at_ms,
            subject,
            context(),
            {"from": before, "to": after, "planId": household.plan},
        )

    # --- one session --------------------------------------------------------------------------

    def _session(self, household: Household, profile: ProfileSim, start_ms: int) -> None:
        config = self.config
        rng = household.rng
        truth = profile.truth
        self.stats.sessions += 1
        profile.sessions += 1
        budget = float(np.clip(np.exp(rng.normal(np.log(45 * 60), 0.7)), 300, 4 * 3600))
        device = (
            household.tv if household.tv is not None and rng.random() < 0.45 else profile.device
        )
        session = AppSession(device=device)
        if rng.random() < config.late_rate:
            session.late_ms = int(rng.integers(HOUR_MS, 72 * HOUR_MS))
        session.sampled = rng.random() < config.impression_sample_rate
        # Kids profiles: only the server playback events needed to operate the service.
        client_events = not truth.kids and (
            household.analytics or household.personalisation_at(start_ms)
        )
        explore = rng.random() < config.explore_rate
        policy_ctx = {"id": config.policy_id, "explore": explore}
        experiments = profile.assignments
        t = start_ms
        subject = self.subject(household, profile, t)
        self._decay_fatigue(profile, start_ms)
        if rng.random() < 0.03:
            # A sign-in happens at the profile gate: the account is known, no profile yet.
            gate = self.subject(household, None, t)
            self.emit.server(
                ev.AUTH_SIGNIN, t, gate, context(), {"method": "password", "outcome": "success"}
            )
        page = self.policy.home(
            profile_hash=profile.truth.account * 7 + profile.truth.number,
            ceiling_rank=truth.ceiling_rank,
            library=profile.library,
            now_ms=t,
            explore=explore,
            rng=rng,
        )
        for key, variant in experiments.items():
            # As the product logs it (personalisation's serving plan): the unit's assignments and
            # the page's policy in the context, no device, once per unit and variant per 30 days
            # (the emitter drops the repeats after its random draws).
            self.emit.server(
                ev.EXPOSURE,
                t + 50,
                subject,
                context(experiments=experiments, policy=policy_ctx),
                {"experimentKey": key, "variant": variant, "unitType": "profile"},
            )
        u_dyn = self._dynamic_utility(profile, t)
        t += int(rng.integers(800, 3000))

        if client_events and rng.random() < 0.07:
            t, budget = self._search(
                household, profile, session, subject, u_dyn, t, budget, experiments
            )
            if budget < 120:
                return
        for row_rank, module in enumerate(page, start=1):
            if budget < 90:
                break
            if (
                row_rank > 1
                and module.kind != "continue-watching"
                and rng.random() > truth.patience
            ):
                break
            t, budget, played = self._module(
                household, profile, session, subject, module, row_rank, u_dyn, t, budget,
                client_events, policy_ctx, experiments,
            )  # fmt: skip
            if played:
                if budget < 20 * 60 or rng.random() > 0.35:
                    break
                u_dyn = self._dynamic_utility(profile, t)

    def _decay_fatigue(self, profile: ProfileSim, at_ms: int) -> None:
        day = at_ms // DAY_MS
        if day > profile.fatigue_day:
            profile.fatigue *= 0.85 ** (day - profile.fatigue_day)
            profile.fatigue_day = int(day)

    def _dynamic_utility(self, profile: ProfileSim, at_ms: int) -> npt.NDArray[np.float64]:
        catalog = self.catalog
        age_days = (at_ms - catalog.added_at) / DAY_MS
        novelty = np.where(
            age_days >= 0,
            1.5 * profile.truth.novelty * np.exp(-np.maximum(age_days, 0) / 12.0),
            0.0,
        )
        value = profile.utility + novelty - 0.25 * np.log1p(profile.fatigue)
        for title, progress in profile.library.progress.items():
            if progress.finished:
                value[title] -= 2.5
            elif progress.dropped:
                value[title] -= 2.0
        return value

    def _module(
        self,
        household: Household,
        profile: ProfileSim,
        session: AppSession,
        subject: Subject,
        module: Module,
        row_rank: int,
        u_dyn: npt.NDArray[np.float64],
        t: int,
        budget: float,
        client_events: bool,
        policy_ctx: dict[str, Any],
        experiments: dict[str, str],
    ) -> tuple[int, float, bool]:
        rng = household.rng
        if module.kind == "billboard":
            count = 1
        else:
            count = SCROLLED_CARDS if rng.random() < 0.12 else VISIBLE_CARDS
        items = module.items[:count]
        if len(items) == 0:
            return t, budget, False
        scan_ms = 1500 + 400 * len(items)
        log = client_events and session.sampled
        if log:
            row_ctx = context(
                surface="home",
                row_id=module.row_id,
                row_rank=row_rank,
                experiments=experiments,
                policy=policy_ctx,
            )
            self.emit.client(
                ev.ROW_VIEW,
                t,
                session,
                subject,
                row_ctx,
                {
                    "rowKind": module.kind,
                    "itemCount": len(module.items),
                    "sampleRate": self.config.impression_sample_rate,
                },
            )
            for k, title in enumerate(items, start=1):
                card_ctx = context(
                    surface="home",
                    row_id=module.row_id,
                    row_rank=row_rank,
                    rank=k,
                    experiments=experiments,
                    policy=policy_ctx,
                )
                self.emit.client(
                    ev.IMPRESSION,
                    t + 1000 + 150 * k,
                    session,
                    subject,
                    card_ctx,
                    {
                        "titleId": self.ids[int(title)],
                        "sampleRate": self.config.impression_sample_rate,
                    },
                )
            if module.kind == "billboard" and rng.random() < 0.5:
                bb_ctx = context(
                    surface="home",
                    row_id=module.row_id,
                    row_rank=row_rank,
                    rank=1,
                    experiments=experiments,
                    policy=policy_ctx,
                )
                self.emit.client(
                    "preview.start",
                    t + 2500,
                    session,
                    subject,
                    bb_ctx,
                    {"titleId": self.ids[int(items[0])]},
                )
        self.stats.impressions_shown += len(items)
        ranks = np.arange(1, len(items) + 1)
        examined = rng.random(len(items)) < examine_probability(ranks) * row_attention(row_rank)
        if module.kind == "billboard":
            examined = rng.random(1) < 0.85 * row_attention(row_rank)
        if module.kind == "continue-watching":
            p_click = np.array([self._resume_probability(profile, int(title)) for title in items])
        else:
            p_click = sigmoid(2.2 * (u_dyn[items] - 2.0))
        clicks = examined & (rng.random(len(items)) < p_click)
        ignored = items[examined & ~clicks]
        profile.fatigue[ignored] += 1.0
        t += scan_ms
        budget -= scan_ms / 1000
        if client_events:
            wanted = ignored[rng.random(len(ignored)) < 0.2 * sigmoid(2.0 * (u_dyn[ignored] - 2.2))]
            for wanted_title in wanted:
                title = int(wanted_title)
                if title not in profile.library.list_added:
                    profile.library.list_added[title] = t
                    card_ctx = context(
                        surface="home",
                        row_id=module.row_id,
                        row_rank=row_rank,
                        rank=int(np.where(items == title)[0][0]) + 1,
                        experiments=experiments,
                        policy=policy_ctx,
                    )
                    self.emit.client(
                        ev.LIST_ADD, t, session, subject, card_ctx, {"titleId": self.ids[title]}
                    )
        for clicked in np.flatnonzero(clicks):
            position = int(clicked)
            title = int(items[position])
            self.stats.clicks += 1
            card_ctx = context(
                surface="home",
                row_id=module.row_id,
                row_rank=row_rank,
                rank=position + 1,
                experiments=experiments,
                policy=policy_ctx,
            )
            if client_events:
                self.emit.client(
                    ev.TITLE_OPEN, t, session, subject, card_ctx, {"titleId": self.ids[title]}
                )
            t += int(rng.integers(2_000, 15_000))
            resume = module.kind == "continue-watching"
            p_play = (
                1.0
                if resume
                else float(np.clip(sigmoid(1.5 * (profile.utility[title] - 0.5)), 0.25, 0.95))
            )
            if rng.random() < p_play:
                t, budget = self._watch(
                    household, profile, session, subject, title, t, budget, experiments
                )
                return t, budget, True
            if client_events and title not in profile.library.list_added and rng.random() < 0.15:
                profile.library.list_added[title] = t
                self.emit.client(
                    ev.LIST_ADD, t, session, subject, card_ctx, {"titleId": self.ids[title]}
                )
            t += int(rng.integers(1_000, 4_000))
        return t, budget, False

    def _resume_probability(self, profile: ProfileSim, title: int) -> float:
        progress = profile.library.progress.get(title)
        if progress is None or progress.dropped:
            return 0.03
        return float(0.75 * sigmoid(1.2 * (profile.utility[title] - 0.2)))

    def _search(
        self,
        household: Household,
        profile: ProfileSim,
        session: AppSession,
        subject: Subject,
        u_dyn: npt.NDArray[np.float64],
        t: int,
        budget: float,
        experiments: dict[str, str],
    ) -> tuple[int, float]:
        rng = household.rng
        catalog = self.catalog
        visible = (catalog.maturity_rank <= profile.truth.ceiling_rank) & (catalog.added_at <= t)
        candidates = np.flatnonzero(visible)
        if len(candidates) == 0:
            return t, budget
        self.stats.searches += 1
        logits = u_dyn[candidates] / 0.6
        weights = np.exp(logits - logits.max())
        title = int(rng.choice(candidates, p=weights / weights.sum()))
        length = int(rng.integers(3, 16))
        ctx = context(surface="search", experiments=experiments)
        self.emit.client(
            ev.SEARCH_QUERY,
            t,
            session,
            subject,
            ctx,
            {"queryLength": length, "resultCount": int(rng.integers(1, 13))},
        )
        t += int(rng.integers(3_000, 20_000))
        if rng.random() > 0.85:
            return t, budget - 20
        rank = int(min(1 + rng.geometric(0.6) - 1, 10))
        self.emit.client(
            ev.SEARCH_CLICK,
            t,
            session,
            subject,
            ctx,
            {"titleId": self.ids[title], "resultRank": rank, "queryLength": length},
        )
        self.emit.client(
            ev.TITLE_OPEN,
            t + 300,
            session,
            subject,
            context(surface="search", rank=rank, experiments=experiments),
            {"titleId": self.ids[title]},
        )
        t += int(rng.integers(2_000, 10_000))
        if rng.random() < float(np.clip(sigmoid(1.5 * (profile.utility[title] - 0.2)), 0.3, 0.97)):
            return self._watch(household, profile, session, subject, title, t, budget, experiments)
        return t, budget - 30

    # --- watching -----------------------------------------------------------------------------

    def _watch(
        self,
        household: Household,
        profile: ProfileSim,
        session: AppSession,
        subject: Subject,
        title: int,
        t: int,
        budget: float,
        experiments: dict[str, str],
    ) -> tuple[int, float]:
        rng = household.rng
        library = profile.library
        meta = self.catalog.titles[title]
        utility = float(profile.utility[title])
        progress = library.progress.get(title)
        if progress is None:
            progress = Progress()
            library.progress[title] = progress
        elif progress.finished:
            # A rewatch starts over.
            progress.finished = False
            progress.item = 0
            progress.position = 0.0
        durations = self.durations[title]
        satisfaction: list[float] = []
        while budget > 60:
            item = min(progress.item, len(durations) - 1)
            duration = durations[item]
            start = progress.position if progress.position < duration * COMPLETION_RATIO else 0.0
            accidental = rng.random() < 0.04
            if accidental:
                target = start + float(rng.uniform(3, 25))
                complete = False
            else:
                bar = 0.5 if meta.is_series else 0.9
                complete = rng.random() < sigmoid(1.6 * (utility - bar)) or duration < 1200
                if complete:
                    target = duration
                else:
                    fraction = float(rng.beta(1.1, 2.2))
                    target = start + max(MIN_COUNTED_SEC + 5, fraction * (duration - start))
            target = min(target, duration)
            watched = max(0.0, min(target - start, budget))
            limited = watched < target - start
            playback_id = f"pb{rng.integers(0, 2**63):016x}"
            episode_id = self.episode_ids[title][item] if meta.is_series else None
            # Playback's server events carry the player surface only (the product's envelope).
            ctx = context(surface="player")
            self.emit.server(
                ev.PLAYBACK_START,
                t,
                subject,
                ctx,
                self._item(playback_id, title, episode_id, start, duration, 0.0),
            )
            end_position = start + watched
            for quarter in (0.25, 0.5, 0.75):
                mark = quarter * duration
                if start < mark <= end_position:
                    at = t + int((mark - start) * 1000)
                    self.emit.server(
                        ev.PLAYBACK_PROGRESS,
                        at,
                        subject,
                        ctx,
                        self._item(playback_id, title, episode_id, mark, duration, mark - start),
                    )
            t += int(watched * 1000)
            budget -= watched
            finished_item = end_position >= duration * COMPLETION_RATIO
            if finished_item:
                self.emit.server(
                    ev.PLAYBACK_COMPLETE,
                    t,
                    subject,
                    ctx,
                    self._item(
                        playback_id,
                        title,
                        episode_id,
                        min(end_position, duration),
                        duration,
                        watched,
                    ),
                )
            else:
                # Stopped by choice (or a sample): the player is closed and the session released.
                # Out of time mid-item: the member leaves without releasing it (a closed tab),
                # and the product's expiry sweep ends it minutes after the last report, with
                # `expired` (lease lifetime + carry + margin, then the next scheduler tick).
                expired = limited and not accidental
                self.emit.server(
                    ev.PLAYBACK_ABANDON,
                    t,
                    subject,
                    ctx,
                    {
                        **self._item(
                            playback_id, title, episode_id, end_position, duration, watched
                        ),
                        "reason": "expired" if expired else "closed",
                    },
                    receipt_delay_ms=(140_000 + int(playback_id[-8:], 16) % 60_000)
                    if expired
                    else 0,
                )
            self.stats.plays += 1
            profile.plays += 1
            progress.last_ms = t
            if watched >= MIN_COUNTED_SEC or finished_item:
                progress.engaged = True
                if start < MIN_COUNTED_SEC:
                    progress.started += 1
            if finished_item:
                progress.completed += 1
                progress.position = 0.0
                if item + 1 < len(durations):
                    progress.item = item + 1
                else:
                    progress.finished = True
                    progress.item = 0
            else:
                progress.position = end_position
                if not limited and not accidental:
                    progress.dropped = True
            satisfaction.append(
                float(sigmoid(utility)) * (0.4 + 0.6 * min(1.0, end_position / duration))
            )
            if accidental or progress.dropped or progress.finished or limited:
                break
            # Next episode: autoplay keeps a member who likes the series watching.
            if budget < 10 * 60 or rng.random() > sigmoid(1.5 * (utility - 0.4)):
                break
            t += 10_000
        if satisfaction:
            household.satisfaction = 0.85 * household.satisfaction + 0.15 * float(
                np.mean(satisfaction)
            )
        self._after_watch(
            household, profile, session, subject, title, t, utility, progress, experiments
        )
        return t, budget

    def _item(
        self,
        playback_id: str,
        title: int,
        episode_id: str | None,
        position: float,
        duration: float,
        watched: float,
    ) -> dict[str, Any]:
        return {
            "playbackSessionId": playback_id,
            "titleId": self.ids[title],
            "episodeId": episode_id,
            "positionSec": round(position, 3),
            "durationSec": round(duration, 3),
            "watchedSec": round(max(watched, 0.0), 3),
        }

    def _after_watch(
        self,
        household: Household,
        profile: ProfileSim,
        session: AppSession,
        subject: Subject,
        title: int,
        t: int,
        utility: float,
        progress: Progress,
        experiments: dict[str, str],
    ) -> None:
        rng = household.rng
        client_events = not profile.truth.kids and (
            household.analytics or household.personalisation_at(t)
        )
        library = profile.library
        if not client_events:
            if progress.dropped and title in library.list_added:
                del library.list_added[title]
            return
        ctx = context(surface="title-detail", experiments=experiments)
        rate = 0.1 if progress.finished else 0.05 if progress.dropped else 0.0
        if rate and rng.random() < rate:
            if progress.dropped:
                value = "dislike" if utility < 1.0 or rng.random() < 0.5 else None
            else:
                value = (
                    "love"
                    if utility > 2.2
                    else "like"
                    if utility > 0.8
                    else "dislike"
                    if utility < -0.5
                    else None
                )
            if value is not None:
                library.ratings[title] = value
                self.emit.client(
                    ev.RATING_SET,
                    t + 2_000,
                    session,
                    subject,
                    ctx,
                    {"titleId": self.ids[title], "value": value},
                )
        if (
            (progress.finished or progress.dropped)
            and title in library.list_added
            and rng.random() < 0.5
        ):
            del library.list_added[title]
            self.emit.client(
                ev.LIST_REMOVE, t + 4_000, session, subject, ctx, {"titleId": self.ids[title]}
            )
