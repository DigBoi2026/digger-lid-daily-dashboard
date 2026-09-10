#!/usr/bin/env python3
"""Read a watchdog or health response on stdin; print a one-line reason and set
the exit code.

A separate file rather than a python3 -c inside the workflow: the reason-
extraction needs a try/except and a loop, and multi-line Python inside a YAML
block scalar has to be indented to survive, which makes it unreadable and
breaks the file the moment somebody reflows it. It is also testable this way —
source/test_watchdog.js drives it.

    exit 0  the response says everything is fine
    exit 1  it does not, or could not be parsed

Usage: verdict.py <label> <http_status>
"""
import json
import sys


def main() -> int:
    label = sys.argv[1] if len(sys.argv) > 1 else "response"
    status = sys.argv[2] if len(sys.argv) > 2 else ""
    raw = sys.stdin.read()

    try:
        d = json.loads(raw)
    except Exception:
        # An unparseable body is itself the finding: a proxy error page, an HTML
        # login challenge, or a truncated response all land here.
        print("%s: unparseable response (HTTP %s): %s" % (label, status or "?", raw.strip()[:200]))
        return 1

    if not isinstance(d, dict):
        print("%s: unexpected JSON shape (HTTP %s)" % (label, status or "?"))
        return 1

    reasons = [str(f) for f in (d.get("failures") or [])]

    # Anything that reported its own error string, in case `failures` is absent —
    # /api/health predates the watchdog and reports per-check errors instead.
    for name, check in (d.get("checks") or {}).items():
        if isinstance(check, dict) and check.get("error"):
            reasons.append("%s: %s" % (name, check["error"]))
    for name in ("sheets", "shopify", "posthog"):
        c = d.get(name)
        if isinstance(c, dict) and c.get("error"):
            reasons.append("%s: %s" % (name, c["error"]))

    healthy = d.get("ok")
    if healthy is True and not reasons and (status in ("", "200")):
        return 0

    if not reasons:
        reasons = ["ok=%r, HTTP %s" % (healthy, status or "?")]
    print("%s: %s" % (label, " | ".join(reasons)))
    return 1


if __name__ == "__main__":
    sys.exit(main())
