#!/bin/bash
# Regenerate the checked-in `git merge-tree --write-tree -z` fixtures that parse.test.ts
# reads. Usage, from the repo root:
#
#   bash apps/backend/src/conflict/__fixtures__/merge-tree/generate.sh \
#        apps/backend/src/conflict/__fixtures__/merge-tree
#
# The shas move every run (commit timestamps), which is why each `.bin` has a `.json` beside
# it carrying the two committishes — the file/directory mangling embeds them.
set -u
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_ADVICE=0
OUT="$1"
mkdir -p "$OUT"

mkrepo() { W=$(mktemp -d /tmp/pierre-fx.XXXXXX); cd "$W" || exit 1; git init -q -b main .; git config user.email a@b.c; git config user.name t; }

# ---- all-kinds: text + binary + modify/delete + file/directory + rename/rename + a real `~` ----
mkrepo
printf 'a\nb\nc\n' > f.txt
printf '\x01\x00\x02' > bin.dat
printf 'orig\n' > ren.txt
printf 'del\n' > del.txt
printf 'fd\n' > fdir.txt
printf 'has~tilde\n' > 'we~ird.txt'
git add -A; git commit -qm base
git checkout -qb ours
printf 'a\nOURS\nc\n' > f.txt
printf '\x01\x00\x03' > bin.dat
git mv ren.txt ren-ours.txt
printf 'changed\n' > del.txt
rm fdir.txt; mkdir fdir.txt; printf 'inside\n' > fdir.txt/x
printf 'o\n' > 'we~ird.txt'
git add -A; git commit -qm ours
git checkout -q main; git checkout -qb theirs
printf 'a\nTHEIRS\nc\n' > f.txt
printf '\x01\x00\x04' > bin.dat
git mv ren.txt ren-theirs.txt
git rm -q del.txt
printf 'fd2\n' > fdir.txt
printf 't\n' > 'we~ird.txt'
git add -A; git commit -qm theirs
OS=$(git rev-parse ours); TS=$(git rev-parse theirs)
git merge-tree --write-tree -z "$OS" "$TS" > "$OUT/all-kinds.bin" 2>/dev/null
echo "{\"ours\":\"$OS\",\"theirs\":\"$TS\"}" > "$OUT/all-kinds.json"

# ---- clean: two far-apart edits git auto-merges ----
mkrepo
printf 'a\nb\nc\nd\ne\nf\ng\nh\n' > f.txt; git add -A; git commit -qm base
git checkout -qb ours; printf 'A\nb\nc\nd\ne\nf\ng\nh\n' > f.txt; git commit -qam ours
git checkout -q main; git checkout -qb theirs; printf 'a\nb\nc\nd\ne\nf\ng\nH\n' > f.txt; git commit -qam theirs
OS=$(git rev-parse ours); TS=$(git rev-parse theirs)
git merge-tree --write-tree -z "$OS" "$TS" > "$OUT/clean.bin" 2>/dev/null
echo "{\"ours\":\"$OS\",\"theirs\":\"$TS\"}" > "$OUT/clean.json"

# ---- submodule: a gitlink changed on both sides (no real submodule needed) ----
mkrepo
printf 'x\n' > a.txt; git add -A; git commit -qm base
S1=$(git rev-parse HEAD); git update-index --add --cacheinfo 160000,"$S1",sub; git commit -qm addsub
git checkout -qb ours; printf 'y\n' > a.txt; git commit -qam o
S2=$(git rev-parse HEAD); git update-index --add --cacheinfo 160000,"$S2",sub; git commit -qm subo
git checkout -q main; git checkout -qb theirs; printf 'z\n' > a.txt; git commit -qam t
S3=$(git rev-parse HEAD); git update-index --add --cacheinfo 160000,"$S3",sub; git commit -qm subt
OS=$(git rev-parse ours); TS=$(git rev-parse theirs)
git merge-tree --write-tree -z "$OS" "$TS" > "$OUT/submodule.bin" 2>/dev/null
echo "{\"ours\":\"$OS\",\"theirs\":\"$TS\"}" > "$OUT/submodule.json"

ls -l "$OUT"
