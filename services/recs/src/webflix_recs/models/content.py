"""Content vectors from catalogue metadata and synopsis: TF-IDF, then truncated SVD.

Two vocabularies are weighted and concatenated: free text (name, tagline, synopsis; English
stop words removed, sublinear term frequency) and metadata tokens (`genre:…` by relevance
order, `mood:…`, `person:…` for directors, creators and lead cast, `type:…`, `era:…`,
`original`). A 24-dimensional SVD folds synonyms and co-occurring tokens together, and the
rows are L2-normalised so that dot products are cosines. These vectors give cold-start titles
neighbours and MF factors (models/als.py) before anyone has watched them.

Why not a sentence-embedding model: it would pull a deep-learning stack of several gigabytes
into the job image for a catalogue of 120 short synopses, where metadata already carries most
of the signal. TF-IDF + SVD is milliseconds, deterministic and dependency-light.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import numpy.typing as npt
from scipy import sparse
from sklearn.decomposition import TruncatedSVD
from sklearn.feature_extraction.text import TfidfVectorizer

from webflix_recs.catalog import Catalog

Matrix = npt.NDArray[np.float64]

TEXT_WEIGHT = 0.6
META_WEIGHT = 1.0


def _metadata_tokens(catalog: Catalog) -> list[str]:
    documents = []
    for title in catalog.titles:
        tokens = []
        for order, genre in enumerate(title.genre_ids):
            tokens.extend([f"genre_{genre}"] * (3 if order == 0 else 2 if order == 1 else 1))
        tokens.extend(f"mood_{mood.lower().replace(' ', '_')}" for mood in title.moods)
        tokens.extend(
            f"person_{credit.person_id}"
            for credit in title.credits
            if credit.role in {"director", "creator"}
            or (credit.role == "cast" and credit.position < 3)
        )
        tokens.append(f"type_{title.type}")
        tokens.append(f"era_{title.release_year // 10 * 10}")
        if title.is_original:
            tokens.append("original")
        documents.append(" ".join(tokens))
    return documents


@dataclass
class ContentModel:
    vectors: Matrix  # T x d, L2-normalised
    explained_variance: float

    @classmethod
    def fit(cls, catalog: Catalog, *, dimensions: int = 24, seed: int = 7) -> ContentModel:
        text = [
            " ".join(filter(None, [t.name, t.tagline or "", t.synopsis])) for t in catalog.titles
        ]
        text_matrix = TfidfVectorizer(
            stop_words="english", sublinear_tf=True, min_df=1
        ).fit_transform(text)
        meta_matrix = TfidfVectorizer(
            token_pattern=r"[^ ]+",  # noqa: S106 - a regular expression, not a secret
            lowercase=False,
            sublinear_tf=True,
        ).fit_transform(_metadata_tokens(catalog))
        combined = sparse.hstack([TEXT_WEIGHT * text_matrix, META_WEIGHT * meta_matrix]).tocsr()
        dimensions = min(dimensions, min(combined.shape) - 1)
        svd = TruncatedSVD(n_components=dimensions, random_state=seed, algorithm="arpack")
        reduced = svd.fit_transform(combined)
        norms = np.linalg.norm(reduced, axis=1, keepdims=True)
        vectors = reduced / np.where(norms == 0, 1.0, norms)
        return cls(vectors=vectors, explained_variance=float(svd.explained_variance_ratio_.sum()))

    @property
    def similarity(self) -> Matrix:
        sim: Matrix = self.vectors @ self.vectors.T
        return sim

    def profile_affinity(self, strength: npt.NDArray[np.float32]) -> Matrix:
        """Cosine between each profile's strength-weighted content taste and every title."""
        taste = strength.astype(np.float64) @ self.vectors
        norms = np.linalg.norm(taste, axis=1, keepdims=True)
        taste = taste / np.where(norms == 0, 1.0, norms)
        result: Matrix = taste @ self.vectors.T
        return result
