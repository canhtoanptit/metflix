"""Copy every object under some prefixes from one pipeline store to another.

  python copy_objects.py SOURCE TARGET PREFIX [PREFIX ...]

Stores are what `webflix-recs --store` takes: a directory in the filesystem BlobStore layout,
or s3://bucket[/prefix] (WEBFLIX_S3_*). The train-and-score Job uses it to put the catalogue
snapshot, which `services/recs/scripts/export-catalog.ts` writes to a directory, into the
bucket. A pointer (`*/current.json`) is copied last, after the objects it points at.
"""

from __future__ import annotations

import json
import sys

from webflix_recs.storage import open_storage


def main(argv: list[str]) -> int:
    if len(argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    source, target = open_storage(argv[0]), open_storage(argv[1])
    keys = sorted({info.key for prefix in argv[2:] for info in source.list(prefix)})
    # Pointers last: a reader that finds one finds everything it names.
    keys.sort(key=lambda key: key.endswith("/current.json"))
    copied = 0
    for key in keys:
        data = source.get(key)
        if data is None:
            continue
        target.put(key, data)
        copied += 1
    print(json.dumps({"copied": copied, "keys": keys}))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
