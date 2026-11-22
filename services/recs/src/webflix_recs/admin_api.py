"""The staff API, for the jobs that need the product's answer and must not touch its database.

Two jobs talk to the product (docs/BACKEND.md §3, "The staff API"):

* `erase` reads `GET /system/privacy/erasures` (pseudonymous keys whose events must go; role
  `admin`) and, once it has verified that nothing of them is left, records it with
  `POST /system/privacy/erasures/confirm` (at most 200 keys per call, with a reason: the
  product's audit log keeps it);
* `export-events` reads `GET /system/privacy/exports` (the data exports whose events are not
  extracted yet; role `admin`) and records what it did with
  `POST /system/privacy/exports/results` (at most 500 results per call, with a reason);
* `analyse-experiments` can read the experiment definitions with `GET /experiments` (role
  `experiments`).

Configuration (environment):

* `WEBFLIX_ADMIN_API_URL`: the staff API's base, e.g. `https://webflix.example/api/admin/v1`;
* a bearer token, one of: `WEBFLIX_STAFF_TOKEN` (an access token obtained elsewhere), or
  `WEBFLIX_STAFF_TOKEN_URL` with `WEBFLIX_STAFF_CLIENT_ID` and either
  `WEBFLIX_STAFF_CLIENT_SECRET` (OAuth 2.0 client credentials, the client authenticated with
  HTTP Basic: a service account of the staff issuer, e.g. a Keycloak client whose service
  account holds the `admin` role of `webflix-admin`; in dev, the development issuer's
  `webflix-jobs` client at `{origin}/dev-idp/staff/token`) or `WEBFLIX_STAFF_REFRESH_TOKEN` (the
  refresh-token grant), optionally `WEBFLIX_STAFF_SCOPE`. Tokens are fetched again shortly
  before they expire (the product's last five minutes).

Standard library only (urllib): the job image needs no HTTP client dependency.
"""

from __future__ import annotations

import base64
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any

import orjson

CONFIRM_BATCH = 200
LIST_LIMIT = 500
RESULTS_BATCH = 500


class AdminApiError(RuntimeError):
    """The staff API refused or could not be reached (CLI exit code 6)."""


def _request(
    url: str,
    *,
    method: str = "GET",
    body: bytes | None = None,
    headers: Mapping[str, str] | None = None,
    timeout: float = 30.0,
) -> Any:
    request = urllib.request.Request(url, data=body, method=method, headers=dict(headers or {}))  # noqa: S310 - configured https/http base
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
            payload = response.read()
    except urllib.error.HTTPError as error:
        detail = error.read()[:500].decode("utf-8", "replace")
        raise AdminApiError(f"{method} {url}: HTTP {error.code}: {detail}") from error
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise AdminApiError(f"{method} {url}: {error}") from error
    if not payload:
        return None
    try:
        return orjson.loads(payload)
    except orjson.JSONDecodeError as error:
        raise AdminApiError(f"{method} {url}: the answer is not JSON") from error


@dataclass
class TokenSource:
    """A static token, or one minted (and cached until shortly before it expires) from the
    staff issuer's token endpoint."""

    static: str | None = None
    token_url: str | None = None
    form: dict[str, str] = field(default_factory=dict)
    #: HTTP Basic client authentication (`client_secret_basic`, RFC 6749 §2.3.1).
    basic: tuple[str, str] | None = None
    _cached: tuple[str, float] | None = None

    def __call__(self) -> str:
        if self.static:
            return self.static
        if self._cached and self._cached[1] > time.time():
            return self._cached[0]
        if not self.token_url:
            raise AdminApiError("no staff token configured (see webflix_recs.admin_api)")
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        if self.basic is not None:
            client, secret = (urllib.parse.quote(part, safe="") for part in self.basic)
            encoded = base64.b64encode(f"{client}:{secret}".encode()).decode()
            headers["Authorization"] = f"Basic {encoded}"
        answer = _request(
            self.token_url,
            method="POST",
            body=urllib.parse.urlencode(self.form).encode(),
            headers=headers,
        )
        token = (answer or {}).get("access_token")
        if not isinstance(token, str):
            raise AdminApiError(f"{self.token_url}: no access_token in the answer")
        lifetime = float((answer or {}).get("expires_in", 60))
        self._cached = (token, time.time() + max(5.0, lifetime - 30.0))
        return token

    @classmethod
    def from_environment(cls, env: Mapping[str, str] | None = None) -> TokenSource:
        env = os.environ if env is None else env
        if env.get("WEBFLIX_STAFF_TOKEN"):
            return cls(static=env["WEBFLIX_STAFF_TOKEN"])
        url = env.get("WEBFLIX_STAFF_TOKEN_URL")
        client = env.get("WEBFLIX_STAFF_CLIENT_ID")
        if not url or not client:
            raise AdminApiError(
                "set WEBFLIX_STAFF_TOKEN, or WEBFLIX_STAFF_TOKEN_URL and WEBFLIX_STAFF_CLIENT_ID "
                "with WEBFLIX_STAFF_CLIENT_SECRET or WEBFLIX_STAFF_REFRESH_TOKEN"
            )
        form: dict[str, str] = {}
        if env.get("WEBFLIX_STAFF_REFRESH_TOKEN"):
            form.update(
                grant_type="refresh_token", refresh_token=env["WEBFLIX_STAFF_REFRESH_TOKEN"]
            )
        else:
            form.update(grant_type="client_credentials")
        if env.get("WEBFLIX_STAFF_SCOPE"):
            form["scope"] = env["WEBFLIX_STAFF_SCOPE"]
        secret = env.get("WEBFLIX_STAFF_CLIENT_SECRET")
        if secret:
            return cls(token_url=url, form=form, basic=(client, secret))
        form["client_id"] = client  # a public client (the refresh-token grant)
        return cls(token_url=url, form=form)


@dataclass
class AdminApi:
    base_url: str
    token: Callable[[], str]
    timeout: float = 30.0

    @classmethod
    def from_environment(cls, env: Mapping[str, str] | None = None) -> AdminApi:
        env = os.environ if env is None else env
        base = env.get("WEBFLIX_ADMIN_API_URL")
        if not base:
            raise AdminApiError("WEBFLIX_ADMIN_API_URL is not set (e.g. https://host/api/admin/v1)")
        return cls(base.rstrip("/"), TokenSource.from_environment(env))

    def _call(self, method: str, path: str, body: object | None = None) -> Any:
        headers = {"Authorization": f"Bearer {self.token()}", "Accept": "application/json"}
        data = None
        if body is not None:
            data = orjson.dumps(body)
            headers["Content-Type"] = "application/json"
        if method != "GET":
            headers["X-Webflix-Client"] = "web"  # the API's CSRF guard for mutations
        return _request(
            f"{self.base_url}{path}",
            method=method,
            body=data,
            headers=headers,
            timeout=self.timeout,
        )

    def pending_erasures(self, limit: int = LIST_LIMIT) -> list[str]:
        answer = self._call("GET", f"/system/privacy/erasures?limit={int(limit)}")
        keys = (answer or {}).get("subjectKeys")
        if not isinstance(keys, list) or not all(isinstance(key, str) for key in keys):
            raise AdminApiError("GET /system/privacy/erasures: no subjectKeys list in the answer")
        return list(keys)

    def confirm_erasures(self, keys: list[str], reason: str) -> int:
        for start in range(0, len(keys), CONFIRM_BATCH):
            chunk = keys[start : start + CONFIRM_BATCH]
            self._call(
                "POST", "/system/privacy/erasures/confirm", {"subjectKeys": chunk, "reason": reason}
            )
        return len(keys)

    def pending_exports(self, limit: int = LIST_LIMIT) -> list[dict[str, Any]]:
        """`GET /system/privacy/exports`: `{requests: [{requestId, accountKey, from, to}]}`."""
        answer = self._call("GET", f"/system/privacy/exports?limit={int(limit)}")
        requests = (answer or {}).get("requests")
        if not isinstance(requests, list):
            raise AdminApiError("GET /system/privacy/exports: no requests list in the answer")
        return [item for item in requests if isinstance(item, dict)]

    def record_export_results(self, document: dict[str, Any], reason: str) -> int:
        """`POST /system/privacy/exports/results`: export-events' results document and a
        reason, at most 500 results per call."""
        results = list(document.get("results", []))
        for start in range(0, len(results), RESULTS_BATCH):
            body = {**document, "results": results[start : start + RESULTS_BATCH], "reason": reason}
            self._call("POST", "/system/privacy/exports/results", body)
        return len(results)

    def list_experiments(self) -> list[dict[str, Any]]:
        answer = self._call("GET", "/experiments")
        items = (answer or {}).get("items")
        if not isinstance(items, list):
            raise AdminApiError("GET /experiments: no items list in the answer")
        return [item for item in items if isinstance(item, dict)]
