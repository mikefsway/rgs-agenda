"""Embed session facets with BAAI/bge-small-en-v1.5 into static browser assets.

Facet model (lifted from ucl-explorer): each session is embedded as several
rows — one or more description chunks plus one row per paper title — so a
strong match on any single paper can surface its session, and the matched
facet is returned to the user as evidence.

Outputs (docs/data/):
  facets.json     — [{s: session_idx, kind: "session"|"paper", label}], row-aligned
  embeddings.bin  — float16 row-major matrix, n_facets x 384, L2-normalized
  meta.json       — model, dim, counts

Passages are embedded with no prefix; the browser must embed the user's query
with the bge query prefix ("Represent this sentence for searching relevant
passages: ") to match ucl-explorer behaviour.
"""

from __future__ import annotations

import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"

MODEL = "BAAI/bge-small-en-v1.5"
CHUNK_CHARS = 1500  # bge-small truncates ~512 tokens (~1800 chars); stay under
MIN_TAIL = 300


def chunk(text: str) -> list[str]:
    if len(text) <= CHUNK_CHARS:
        return [text] if text else []
    parts, buf = [], ""
    for para in text.split("\n"):
        if buf and len(buf) + len(para) + 1 > CHUNK_CHARS:
            parts.append(buf.strip())
            buf = para
        else:
            buf = f"{buf}\n{para}" if buf else para
    if buf.strip():
        if parts and len(buf) < MIN_TAIL:
            parts[-1] = f"{parts[-1]}\n{buf.strip()}"
        else:
            parts.append(buf.strip())
    return parts


def main() -> None:
    from sentence_transformers import SentenceTransformer

    sessions = json.loads((DATA / "sessions.json").read_text())["sessions"]
    facets: list[dict] = []
    texts: list[str] = []
    for i, s in enumerate(sessions):
        desc_chunks = chunk(s["description"]) or [""]
        for j, c in enumerate(desc_chunks):
            texts.append(f"{s['title']}. {c}".strip(". "))
            label = s["title"] if j == 0 else f"{s['title']} (cont.)"
            facets.append({"s": i, "kind": "session", "label": label})
        for p in s["papers"]:
            texts.append(p["title"])
            facets.append({"s": i, "kind": "paper", "label": p["title"]})

    model = SentenceTransformer(MODEL)
    vecs = model.encode(texts, batch_size=32, normalize_embeddings=True, show_progress_bar=True)
    mat = np.asarray(vecs, dtype=np.float16)

    (DATA / "embeddings.bin").write_bytes(mat.tobytes())
    (DATA / "facets.json").write_text(json.dumps(facets, ensure_ascii=False))
    (DATA / "meta.json").write_text(json.dumps({
        "model": MODEL, "dim": int(mat.shape[1]), "n_facets": int(mat.shape[0]),
        "n_sessions": len(sessions), "dtype": "float16",
        "query_prefix": "Represent this sentence for searching relevant passages: ",
    }))
    print(f"{mat.shape[0]} facets x {mat.shape[1]} dims -> embeddings.bin "
          f"({(DATA / 'embeddings.bin').stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
