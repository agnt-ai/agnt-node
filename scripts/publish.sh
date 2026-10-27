#!/usr/bin/env bash
# Publishes each workspace given, in the order given, to npm, public and with provenance, but only when
# the version its package.json says is not on npm yet and is newer than npm's `latest`. So a merge to main
# that bumps a package's version publishes it, and every other run publishes nothing: it never republishes
# and never moves `latest` backwards. Prerelease versions (1.2.3-beta.0) are left to a person, who
# publishes them under a dist-tag.
#
# Run by .github/workflows/publish.yml, which is where the OIDC identity that npm's trusted publishing and
# provenance need comes from (the same as agnt-ai/simon-protocol's scripts/publish.sh). No token: npm
# 11.5.1 or later authenticates by trusted publishing on its own. Trusted publishing can only publish a
# package that already exists on npm, so a brand-new package needs its first version published by hand.
#   scripts/publish.sh <workspace directory>...
set -euo pipefail
[ "$#" -gt 0 ] || { echo "usage: $0 <workspace directory>..." >&2; exit 2; }
REGISTRY=https://registry.npmjs.org/
ERR="$(mktemp)"
trap 'rm -f "$ERR"' EXIT

npm --version
for dir in "$@"; do
  name="$(node -p 'require(process.argv[1]).name' "./$dir/package.json")"
  version="$(node -p 'require(process.argv[1]).version' "./$dir/package.json")"

  if ! info="$(npm view "$name" versions dist-tags --json --registry "$REGISTRY" 2>"$ERR")"; then
    if grep -q E404 "$ERR"; then
      echo "::error::$name is not on npm yet. Trusted publishing can only publish a package that exists: publish $name@$version once by hand, add this workflow as its trusted publisher, then re-run."
      exit 1
    fi
    cat "$ERR" >&2
    exit 1
  fi

  # publish | skip:<reason>
  decision="$(node -e '
    const [version, raw] = process.argv.slice(1);
    const info = JSON.parse(raw);
    const versions = [].concat(info.versions ?? []);
    const latest = (info["dist-tags"] ?? {}).latest;
    const parse = (v) => v.split(".").map(Number);
    const newer = (a, b) => { for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
    if (!/^\d+\.\d+\.\d+$/.test(version)) console.log("skip:" + version + " is a prerelease or not a plain version; publish it by hand under a dist-tag");
    else if (versions.includes(version)) console.log("skip:" + version + " is already on npm");
    else if (latest && !newer(parse(version), parse(latest))) console.log("skip:" + version + " is not newer than latest (" + latest + ")");
    else console.log("publish");
  ' "$version" "$info")"

  if [ "$decision" != publish ]; then
    reason="${decision#skip:}"
    case "$reason" in
      *"already on npm") echo "$name: $reason" ;;
      *) echo "::warning::$name: $reason, not published" ;;
    esac
    continue
  fi

  echo "$name: publishing $version"
  (cd "$dir" && npm publish --registry "$REGISTRY" --access public --provenance)
done
