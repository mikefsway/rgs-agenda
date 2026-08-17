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


# Separators written as escapes, never as literal control bytes in source:
# docs/app.js has to produce the same string, and an invisible character is
# not something two files can be checked against each other by eye.
FS = "\u001f"   # between fields of a record
RS = "\u001e"   # between records


def djb2(s: str) -> str:
    h = 5381
    for ch in s:
        h = ((h * 33) ^ ord(ch)) & 0xFFFFFFFF
    return np.base_repr(h, 36).lower()


def content_sig(sessions: list[dict]) -> str:
    """djb2 over everything in sessions.json the page reads, in row order.

    This is what tells a returning visitor's saved route whether the programme
    it describes still exists. The old test was `n_facets|n_sessions`, which
    answers a much narrower question — it catches a refresh that adds or removes
    sessions and misses one that only *edits* them. That is not hypothetical:
    the entity fix of 13 Aug 2026 changed 183 strings and rewrote the whole
    matrix while leaving both counts identical, so every saved route restored
    silently against data it was not built from, keeping stale evidence labels
    and scores that pins and dismissals then went on re-ranking from.

    Deliberately derived from the shipped sessions.json alone, not from the
    embedded `texts`: it is re-derived in test/data.test.mjs, and a signature
    that depended on chunk() would make that test a reimplementation of the
    chunker rather than an independent check. A chunking change moves n_facets
    anyway. app.js only reads this field; test/data.test.mjs is the one that
    re-derives it, so keep those two in step — and note that the JS side has to
    iterate *code points*, because ord() does and charCodeAt() does not. The
    programme contains two emoji, which is enough to make the two disagree.
    """
    parts: list[str] = []
    for s in sessions:
        parts.append(FS.join(str(s.get(k, "")) for k in (
            "id", "eid", "title", "description", "start", "end",
            "venue", "mode", "code", "group", "type")))
        for p in s["papers"]:
            parts.append(FS.join([p.get("title", ""),
                                  *(p.get("affiliations") or [])]))
    return djb2(RS.join(parts))


def order_sig(sessions: list[dict]) -> str:
    """djb2 over the session ids, in row order.

    facets.json addresses sessions by *index*, so the matrix is only meaningful
    against the exact ordering of sessions.json that produced it. Nothing in the
    old counts-based dataSig noticed a permutation — n_facets and n_sessions are
    identical before and after — and a permuted matrix fails silently: every
    session still gets a plausible score, just someone else's. Shipping this
    signature lets the browser refuse the pairing outright. Mirrors profileSig
    in docs/app.js; keep the two implementations in step.
    """
    return djb2("|".join(str(x["id"]) for x in sessions))


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
        "n_sessions": len(sessions), "order_sig": order_sig(sessions),
        "content_sig": content_sig(sessions), "dtype": "float16",
        "query_prefix": "Represent this sentence for searching relevant passages: ",
    }))
    print(f"{mat.shape[0]} facets x {mat.shape[1]} dims -> embeddings.bin "
          f"({(DATA / 'embeddings.bin').stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
