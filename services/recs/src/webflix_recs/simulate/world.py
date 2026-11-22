"""The simulated world: what titles are really like and who the members really are.

Everything here is ground truth. The pipeline never sees it: the simulator writes it to a
separate truth directory, and only the evaluation harness may read it (for regret against the
oracle and for checking the position-bias estimate).

True utility of title t for profile p (static; dynamic effects are applied at choice time):

    U(p, t) = 1.00 * genre_match + 0.40 * mood_match + 0.50 * people_match + type_term
            + quality_weight(p) * quality(t) + 0.55 * <u_p, v_t> / sqrt(d) + noise(p, t)

`quality` correlates with the catalogue's seed popularity (so popularity is a real signal), and
the latent factors `v_t` are only partly explained by genre (so collaborative filtering can
learn something that content features cannot).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt

from webflix_recs.catalog import Catalog

LATENT_DIM = 8
PROFILE_TYPES = ("owner", "partner", "young-adult", "shared", "teen", "kids")
ADULT_TYPES = frozenset({"owner", "partner", "young-adult", "shared"})

# Position bias of the simulated members (ground truth for the propensity estimate): the chance
# of examining the card at 1-based position k of a row that is on screen, and an attention factor
# for the 1-based module position on the page.
EXAMINE_POSITION_EXPONENT = 0.7
ROW_ATTENTION_DECAY = 0.05
ROW_ATTENTION_FLOOR = 0.45


def examine_probability(rank: npt.ArrayLike) -> npt.NDArray[np.float64]:
    return np.power(np.asarray(rank, dtype=np.float64), -EXAMINE_POSITION_EXPONENT)


def row_attention(row_rank: npt.ArrayLike) -> npt.NDArray[np.float64]:
    position = np.asarray(row_rank, dtype=np.float64)
    return np.maximum(ROW_ATTENTION_FLOOR, 1.0 - ROW_ATTENTION_DECAY * (position - 1.0))


@dataclass(frozen=True, slots=True)
class TitleTruth:
    quality: npt.NDArray[np.float64]  # T
    latent: npt.NDArray[np.float64]  # T x d
    lead_people: tuple[tuple[str, ...], ...]  # directors, creators and the first 3 cast


def make_titles(catalog: Catalog, seed: int) -> TitleTruth:
    rng = np.random.default_rng([seed, 0])
    popularity = catalog.popularity
    quality = 0.8 * (popularity - 60.0) / 20.0 + rng.normal(0.0, 0.45, len(catalog))
    genre_basis = rng.normal(0.0, 1.0, (len(catalog.genres), LATENT_DIM))
    genre_part = catalog.genre_matrix @ genre_basis
    genre_part /= np.maximum(np.linalg.norm(genre_part, axis=1, keepdims=True), 1e-9)
    latent = 0.6 * genre_part * np.sqrt(LATENT_DIM) + rng.normal(
        0.0, 0.8, (len(catalog), LATENT_DIM)
    )
    lead_people = tuple(
        tuple(
            credit.person_id
            for credit in title.credits
            if credit.role in {"director", "creator"}
            or (credit.role == "cast" and credit.position < 3)
        )
        for title in catalog.titles
    )
    return TitleTruth(quality=quality, latent=latent, lead_people=lead_people)


@dataclass(slots=True)
class ProfileTruth:
    """One profile's true taste and habits."""

    account: int
    number: int  # 0 = the account owner's profile
    kind: str
    kids: bool
    ceiling_rank: int
    genre: npt.NDArray[np.float64]  # G
    mood: npt.NDArray[np.float64]  # M
    people: dict[str, float]
    series_bias: float
    latent: npt.NDArray[np.float64]  # d
    quality_weight: float
    novelty: float
    activity: float  # sessions per day multiplier
    patience: float  # row continuation probability
    created_offset_days: int  # profile created this many days after the account

    @property
    def restricted(self) -> bool:
        """Kids profiles and profiles with a lowered maturity ceiling (packages/core
        `standingOf`): their events are flagged `restricted`."""
        return self.kids or self.kind == "teen"


def _taste(
    rng: np.random.Generator, base: npt.NDArray[np.float64], share: float
) -> npt.NDArray[np.float64]:
    mixed: npt.NDArray[np.float64] = share * base + np.sqrt(1.0 - share**2) * rng.normal(
        0.0, 1.0, base.shape
    )
    return mixed


def make_household(
    catalog: Catalog,
    account: int,
    rng: np.random.Generator,
    people_pool: tuple[str, ...],
    people_weights: npt.NDArray[np.float64],
) -> list[ProfileTruth]:
    genres = len(catalog.genres)
    moods = len(catalog.mood_vocabulary)
    size = int(rng.choice([1, 2, 3, 4, 5], p=[0.34, 0.30, 0.18, 0.11, 0.07]))
    base_genre = rng.normal(0.0, 1.0, genres)
    base_mood = rng.normal(0.0, 1.0, moods)
    base_latent = rng.normal(0.0, 1.0, LATENT_DIM)
    adult_ceiling = len(catalog.maturity_levels) - 1
    level = {name: rank for rank, name in enumerate(catalog.maturity_levels)}
    kids_genres = [
        catalog.genre_index[g] for g in ("g-kids-family", "g-animation") if g in catalog.genre_index
    ]
    profiles: list[ProfileTruth] = []
    for number in range(size):
        if number == 0:
            kind = "owner"
        else:
            kinds = ["partner", "kids", "teen", "young-adult", "shared"]
            kind = str(rng.choice(kinds, p=[0.38, 0.25, 0.14, 0.12, 0.11]))
        kids = kind == "kids"
        share = {
            "owner": 0.55,
            "partner": 0.6,
            "young-adult": 0.35,
            "shared": 0.85,
            "teen": 0.4,
            "kids": 0.3,
        }[kind]
        genre = 0.9 * _taste(rng, base_genre, share)
        if kids:
            genre[kids_genres] += 2.2
        elif kind == "teen":
            genre[kids_genres] += 0.6
        mood = 0.7 * _taste(rng, base_mood, share)
        favourites = rng.choice(len(people_pool), size=3, replace=False, p=people_weights)
        people = {people_pool[int(i)]: float(rng.uniform(0.6, 1.4)) for i in favourites}
        if kind == "kids":
            ceiling = level.get("7+", 1)
        elif kind == "teen":
            ceiling = level.get(str(rng.choice(["13+", "16+"])), 2)
        else:
            ceiling = adult_ceiling
        activity_mean = {
            "owner": 1.0,
            "partner": 0.85,
            "young-adult": 0.95,
            "shared": 0.6,
            "teen": 0.8,
            "kids": 0.9,
        }[kind]
        profiles.append(
            ProfileTruth(
                account=account,
                number=number,
                kind=kind,
                kids=kids,
                ceiling_rank=ceiling,
                genre=genre,
                mood=mood,
                people=people,
                series_bias=float(rng.normal(0.0, 0.5)),
                latent=_taste(rng, base_latent, share),
                quality_weight=float(rng.uniform(0.5, 1.1)),
                novelty=float(rng.gamma(2.0, 0.25)),
                activity=float(activity_mean * rng.gamma(2.5, 1 / 2.5)),
                patience=float(rng.uniform(0.78, 0.92)),
                created_offset_days=0
                if number == 0 or rng.random() < 0.85
                else int(rng.integers(1, 20)),
            )
        )
    return profiles


def people_pool(
    catalog: Catalog, titles: TitleTruth
) -> tuple[tuple[str, ...], npt.NDArray[np.float64]]:
    """People who lead titles, weighted by how popular their titles are (favourite people)."""
    weight: dict[str, float] = {}
    for title, people in zip(catalog.titles, titles.lead_people, strict=True):
        for person in people:
            weight[person] = weight.get(person, 0.0) + title.popularity / 100.0
    pool = tuple(sorted(weight))
    values = np.array([weight[p] for p in pool])
    return pool, values / values.sum()


def utility_matrix(
    catalog: Catalog, titles: TitleTruth, profiles: list[ProfileTruth], noise_seed: int
) -> npt.NDArray[np.float64]:
    """True static utility, profiles x titles. The idiosyncratic noise is drawn from a generator
    seeded by (seed, account, profile) so it is the same whichever process computes it."""
    genre_weights = catalog.genre_matrix
    genre_norm = genre_weights / genre_weights.sum(axis=1, keepdims=True)
    mood_matrix = catalog.mood_matrix
    mood_counts = np.maximum(mood_matrix.sum(axis=1), 1.0)
    is_series = catalog.is_series.astype(np.float64)
    out = np.empty((len(profiles), len(catalog)))
    for row, profile in enumerate(profiles):
        genre_match = genre_norm @ profile.genre
        mood_match = (mood_matrix @ profile.mood) / mood_counts
        people_match = np.array(
            [
                min(1.5, sum(profile.people.get(person, 0.0) for person in lead))
                for lead in titles.lead_people
            ]
        )
        type_term = profile.series_bias * (is_series - 0.5)
        latent = titles.latent @ profile.latent / np.sqrt(LATENT_DIM)
        noise = np.random.default_rng([noise_seed, 2, profile.account, profile.number]).normal(
            0.0, 0.35, len(catalog)
        )
        out[row] = (
            1.0 * genre_match
            + 0.4 * mood_match
            + 0.5 * people_match
            + type_term
            + profile.quality_weight * titles.quality
            + 0.55 * latent
            + noise
        )
    return out
