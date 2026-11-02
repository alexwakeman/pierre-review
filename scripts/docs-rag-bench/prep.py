import json, re, sqlite3, sys, os, glob, unicodedata
DB, LIB, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
db = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
def fold(s):
    s = unicodedata.normalize("NFKC", s).lower()
    s = re.sub(r"[*_`>|#\\\[\]()\-–—:;,.'\"“”‘’]", " ", s)
    return re.sub(r"\s+", " ", s).strip()
sections = []
DOCS = db.execute("select slug,title,sections from reference_docs where built_at is not null order by id").fetchall()
allsecs = [(t, m) for (_, t, ss) in DOCS for m in json.loads(ss)]
for title, m in allsecs:
    p = os.path.join(LIB, m["path"])
    txt = open(p).read()
    lines = txt.split("\n")
    # body: drop marker, '# title', and the '>' trail/nav header lines
    i = 0
    while i < len(lines) and (lines[i].startswith("<!--") or lines[i].startswith("# ") or lines[i].startswith(">") or not lines[i].strip()):
        i += 1
    body = "\n".join(lines[i:]).strip()
    sections.append({"path": m["path"], "title": m["title"], "summary": m.get("summary",""), "trail": m.get("trail",[]), "headings": m.get("headings",[]), "body": body, "doc": title})
# chunks: paragraphs packed to ~220 words (≈300 tokens), contextual prefix
chunks = []
for s in sections:
    paras = [p for p in re.split(r"\n\s*\n", s["body"]) if p.strip()]
    cur, n = [], 0
    def flush():
        global cur, n
        if cur:
            crumbs = " › ".join([s["doc"]] + s["trail"] + [s["title"]])
            chunks.append({"section": s["path"], "prefix": f"{crumbs}\n{s['summary']}\n\n", "text": "\n\n".join(cur)})
        cur, n = [], 0
    for p in paras:
        w = len(p.split())
        if n and n + w > 220: flush()
        if w > 300:  # cut a long block by words
            ws = p.split()
            for k in range(0, len(ws), 220):
                cur, n = [" ".join(ws[k:k+220])], 220; flush()
            continue
        cur.append(p); n += w
    flush()
folded = {s["path"]: fold(s["body"]) for s in sections}
def section_of_quote(q):
    fq = fold(q.replace("…", " ").replace("...", " "))
    pieces = [x for x in re.split(r"\s{2,}", fq) if x]
    hits = [p for p, b in folded.items() if fq and fq in b]
    return hits
evals = []
for (sid, crit, res) in db.execute("select id, criteria_json, result_json from story_docs_alignments where status='succeeded'"):
    crit = json.loads(crit or "[]"); res = json.loads(res or "{}")
    quotes = re.findall(r'"quote":\s*"((?:[^"\\]|\\.)*)"', json.dumps(res))
    gold = set()
    for q in quotes:
        q = json.loads('"' + q + '"')
        h = section_of_quote(q)
        if len(h) == 1: gold.add(h[0])
    query = "\n".join(c["text"] for c in crit)
    if gold: evals.append({"kind": "story", "id": sid, "query": query, "gold": sorted(gold)})
# chat: gold = sections whose title matches a cited sectionTitle segment
title_to_path = {}
for s in sections: title_to_path.setdefault(s["title"].lower(), []).append(s["path"])
msgs = db.execute("select role, content, citations from reference_doc_chat_messages order by id").fetchall()
prev_user = None
for role, content, cits in msgs:
    if role == "user": prev_user = content; continue
    gold = set()
    for c in json.loads(cits or "[]"):
        for seg in c.get("sectionTitle","").split("; "):
            gold.update(title_to_path.get(seg.strip().lower(), []))
    if gold and prev_user: evals.append({"kind": "chat", "query": prev_user, "gold": sorted(gold)})
json.dump({"sections": sections, "chunks": chunks, "evals": evals}, open(OUT, "w"))
print(len(sections), "sections", len(chunks), "chunks", len(evals), "evals",
      sum(len(e["gold"]) for e in evals), "gold refs", [ (e["kind"], len(e["gold"])) for e in evals])
