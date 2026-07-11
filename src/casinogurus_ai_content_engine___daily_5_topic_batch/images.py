"""Generate featured images for content packages from their `featured_image_prompt`.

Each draft carries a `featured_image_prompt` (with an embedded `alt='...'`). This
module turns that prompt into an actual image via OpenAI's image API, stores the
base64 in SQLite (see `storage.images`), and the viewer/server display it.

Generation is always explicit — nothing here runs during a crew kickoff. Trigger it
from the CLI or from the viewer's "Generate featured image" button.

CLI
---
    # generate for every package that doesn't yet have an image
    python -m casinogurus_ai_content_engine___daily_5_topic_batch.images generate --all

    # only a specific batch, and overwrite existing images
    python -m casinogurus_ai_content_engine___daily_5_topic_batch.images generate --batch 2 --force

    # a single package
    python -m casinogurus_ai_content_engine___daily_5_topic_batch.images generate --package <uuid>

Config (env vars, also read from the project .env):
    OPENAI_API_KEY   required for real generation
    IMAGE_MODEL      default "gpt-image-1" (set "dall-e-3" if gpt-image-1 is unavailable)
    IMAGE_SIZE       default "1024x1024"
"""

from __future__ import annotations

import argparse
import base64
import os
import re
import sys

from casinogurus_ai_content_engine___daily_5_topic_batch.storage import (
    DEFAULT_DB_PATH,
    _PROJECT_ROOT,
    connect,
    get_image,
    save_image,
)

DEFAULT_MODEL = os.environ.get("IMAGE_MODEL", "gpt-image-1")
DEFAULT_SIZE = os.environ.get("IMAGE_SIZE", "1024x1024")

_ALT_RE = re.compile(r"""\s*alt\s*=\s*(['"])(.*?)\1""", re.IGNORECASE | re.DOTALL)


def _load_dotenv() -> None:
    """Load KEY=VALUE pairs from the project .env into os.environ.

    The .env file is treated as the source of truth for local runs, so a value
    edited in .env takes effect on the next call without needing a restart
    (a plain setdefault would cache a stale/placeholder value for the process
    lifetime). Only non-empty values overwrite; blank .env entries are ignored
    so a real shell-exported key is never clobbered by an empty line.
    """
    path = os.path.join(_PROJECT_ROOT, ".env")
    if not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8-sig") as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip("'\"")
            if val:
                os.environ[key] = val
            else:
                os.environ.setdefault(key, val)


def parse_prompt(featured_image_prompt: str) -> tuple[str, str | None]:
    """Split a featured_image_prompt into (clean generation prompt, alt text).

    The prompt embeds the alt attribute, e.g.
        "Illustration of X. alt='A chart and casino tokens'"
    We strip the alt segment from the prompt and return the alt text separately.
    """
    if not featured_image_prompt:
        return "", None
    m = _ALT_RE.search(featured_image_prompt)
    alt = m.group(2).strip() if m else None
    clean = _ALT_RE.sub("", featured_image_prompt).strip().rstrip(".").strip()
    return clean or featured_image_prompt.strip(), alt


def generate_image_b64(
    prompt: str, model: str = DEFAULT_MODEL, size: str = DEFAULT_SIZE
) -> tuple[str, str]:
    """Call the OpenAI image API and return (base64_png, mime_type).

    Raises RuntimeError with an actionable message if the SDK/key is missing.
    """
    _load_dotenv()
    # Use the exact same credentials/endpoint the crew's OpenAI LLMs use.
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        raise RuntimeError(
            "OPENAI_API_KEY is not set. Add it to the project .env or the environment "
            "(this is the same key the crew's openai/gpt-4.1 agents use)."
        )
    # crewai/litellm read a custom endpoint from OPENAI_API_BASE; the OpenAI SDK
    # reads OPENAI_BASE_URL. Honour either so image gen follows the crew's config.
    base_url = os.environ.get("OPENAI_BASE_URL") or os.environ.get("OPENAI_API_BASE")

    try:
        from openai import OpenAI
    except ModuleNotFoundError as e:
        raise RuntimeError(
            "The 'openai' package is not installed. Run `crewai install` / "
            "`uv sync` (it ships with crewai), or `uv add openai`."
        ) from e

    client_kwargs = {"api_key": api_key}
    if base_url:
        client_kwargs["base_url"] = base_url
    client = OpenAI(**client_kwargs)
    kwargs = {"model": model, "prompt": prompt, "size": size, "n": 1}
    # dall-e-* needs an explicit response format; gpt-image-1 always returns b64.
    if model.startswith("dall-e"):
        kwargs["response_format"] = "b64_json"

    result = client.images.generate(**kwargs)
    b64 = result.data[0].b64_json
    if not b64:
        raise RuntimeError("Image API returned no base64 data.")
    # sanity check that it decodes
    base64.b64decode(b64)
    return b64, "image/png"


def generate_for_package(
    package_id: str,
    *,
    force: bool = False,
    model: str = DEFAULT_MODEL,
    size: str = DEFAULT_SIZE,
    db_path: str = DEFAULT_DB_PATH,
) -> dict:
    """Generate + store the image for one package. Returns the stored image row.

    Skips (returns the existing row) if an image already exists and force is False.
    On generation failure, stores a status='error' row and returns it (does not raise).
    """
    existing = get_image(package_id, db_path=db_path)
    if existing and existing.get("status") == "ok" and existing.get("image_b64") and not force:
        return existing

    conn = connect(db_path)
    try:
        row = conn.execute(
            "SELECT featured_image_prompt, topic FROM packages WHERE package_id = ?",
            (package_id,),
        ).fetchone()
    finally:
        conn.close()
    if row is None:
        raise ValueError(f"No package with id {package_id!r}")

    raw_prompt = row["featured_image_prompt"] or ""
    prompt, alt = parse_prompt(raw_prompt)
    if not prompt:
        save_image(
            package_id, None, prompt=raw_prompt, alt_text=alt, model=model, size=size,
            status="error", error="Package has no featured_image_prompt.", db_path=db_path,
        )
        return get_image(package_id, db_path=db_path)

    try:
        b64, mime = generate_image_b64(prompt, model=model, size=size)
        save_image(
            package_id, b64, prompt=prompt, alt_text=alt, mime_type=mime,
            model=model, size=size, status="ok", db_path=db_path,
        )
    except Exception as e:  # store the failure so the UI can show it
        save_image(
            package_id, None, prompt=prompt, alt_text=alt, model=model, size=size,
            status="error", error=str(e), db_path=db_path,
        )
    return get_image(package_id, db_path=db_path)


def _package_ids(db_path: str, batch_id: int | None) -> list[str]:
    conn = connect(db_path)
    try:
        if batch_id is None:
            rows = conn.execute("SELECT package_id FROM packages").fetchall()
        else:
            rows = conn.execute(
                "SELECT package_id FROM packages WHERE batch_id = ?", (batch_id,)
            ).fetchall()
        return [r["package_id"] for r in rows]
    finally:
        conn.close()


def generate_for_batch(
    batch_id: int | None = None,
    *,
    force: bool = False,
    model: str = DEFAULT_MODEL,
    size: str = DEFAULT_SIZE,
    db_path: str = DEFAULT_DB_PATH,
) -> list[dict]:
    """Generate images for all packages (optionally in one batch). Returns rows."""
    ids = _package_ids(db_path, batch_id)
    out = []
    for pid in ids:
        res = generate_for_package(
            pid, force=force, model=model, size=size, db_path=db_path
        )
        state = res.get("status") if res else "unknown"
        print(f"  {pid}: {state}" + (f" — {res.get('error')}" if res and res.get("error") else ""))
        out.append(res)
    return out


def _main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Generate featured images from prompts.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    g = sub.add_parser("generate", help="Generate images and store them.")
    g.add_argument("--all", action="store_true", help="All packages in the DB.")
    g.add_argument("--batch", type=int, help="Only this batch id.")
    g.add_argument("--package", help="Only this package id.")
    g.add_argument("--force", action="store_true", help="Regenerate even if present.")
    g.add_argument("--model", default=DEFAULT_MODEL)
    g.add_argument("--size", default=DEFAULT_SIZE)
    g.add_argument("--db", default=DEFAULT_DB_PATH)
    args = ap.parse_args(argv)

    if args.cmd == "generate":
        if args.package:
            res = generate_for_package(
                args.package, force=args.force, model=args.model,
                size=args.size, db_path=args.db,
            )
            print(res.get("status") if res else "unknown", "-", args.package)
            return 0
        if not (args.all or args.batch):
            print("Specify --all, --batch <id>, or --package <id>.", file=sys.stderr)
            return 2
        print(f"Generating images (model={args.model}, size={args.size})...")
        generate_for_batch(
            batch_id=args.batch, force=args.force, model=args.model,
            size=args.size, db_path=args.db,
        )
        return 0
    return 2


if __name__ == "__main__":
    raise SystemExit(_main(sys.argv[1:]))
