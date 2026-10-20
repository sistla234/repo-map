#!/usr/bin/env bash
# Builds a throwaway repo (with a local bare "origin") that has one branch in every state.
# Usage: scripts/make-sandbox.sh [dir]   → then: node bin/repo-map.js <dir>/work
set -e
D="${1:-/tmp/rm-sandbox}"; rm -rf "$D"; mkdir -p "$D"; cd "$D"
git init -q --bare origin.git; git clone -q origin.git work 2>/dev/null; cd work
git config user.email t@t; git config user.name T
n=0; c(){ n=$((n+1)); d="2026-10-$(printf %02d $((5+n/2)))T1$((n%10)):00:00"; GIT_AUTHOR_DATE=$d GIT_COMMITTER_DATE=$d git commit -qam "$1"; }
git switch -q -c main; echo 1>a; git add .; c "Initial prototype"
for m in "Add home screen" "Nav component" "Hero section" "Footer links"; do echo $m>>a; c "$m"; done
git push -q -u origin main; git remote set-head origin main
mk(){ git switch -q -c $1 main; echo $1>$1.txt; git add .; c "$2"; }
mk synced "Tweak nav spacing"; git push -q -u origin synced
mk clashy "Rewrite hero copy"; echo "branch side">clash.txt; git add .; c "Branch edits clash"
git switch -q main; echo "main side">clash.txt; echo m1>>a; git add .; c "Main edits clash"; git push -q
mk unpushed "Add pricing card variants"; git push -q -u origin unpushed; echo more>>unpushed.txt; c "WIP pricing hover"; echo more2>>unpushed.txt; c "Pricing mobile layout"
mk nupstream "Try dark mode"; echo d>>nupstream.txt; c "Dark mode tokens"
mk needspull "Onboarding step 2"; git push -q -u origin needspull
git clone -q ../origin.git ../other; (cd ../other; git config user.email o@o; git config user.name O; git switch -q needspull; echo x>x; git add .; GIT_COMMITTER_DATE=2026-10-14T10:00:00 git commit -qm "Teammate: copy edits"; echo xx>>x; GIT_COMMITTER_DATE=2026-10-14T12:00:00 git commit -qam "Teammate: spacing"; git push -q)
mk diverge "Checkout flow v1"; git push -q -u origin diverge
(cd ../other; git fetch -q; git switch -q diverge; echo y>y; git add .; GIT_COMMITTER_DATE=2026-10-15T10:00:00 git commit -qm "Teammate: fix button"; git push -q)
echo l>l; git add .; c "Local-only checkout tweak"
git switch -q -c done-feature main; echo f1>f1; git add .; GIT_COMMITTER_DATE=2026-10-12T09:00:00 c "Done feature part 1"; echo f2>f2; git add .; GIT_COMMITTER_DATE=2026-10-12T10:00:00 c "Done feature part 2"
git switch -q main; GIT_COMMITTER_DATE=2026-10-13T09:00:00 git merge -q --no-ff done-feature -m "Merge pull request #7 from sistla/done-feature"; git branch -q -d done-feature; git push -q
git switch -q synced; echo wip>wip.txt; echo m>>synced.txt; git fetch -q
echo "Sandbox ready: $D/work"
