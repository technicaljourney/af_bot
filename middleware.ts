import { NextRequest, NextResponse } from "next/server";

/**
 * Recovery for poisoned/stacked address-bar URLs, e.g.
 *   /157.250.198.27:8080/157.250.198.27:8080/.../
 * Those requests would otherwise 404 (or, combined with Next's trailing-slash
 * 308, get cached by the browser into a redirect loop -> ERR_TOO_MANY_REDIRECTS).
 *
 * We detect any path that has the server host or a host:port segment leaked into
 * it (no real route does) and bounce it to the app root with a NON-cacheable 307
 * so nothing accumulates in the browser's redirect cache.
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const looksPoisoned =
    pathname.includes("157.250.198.27") ||
    /\/[^/]*:\d{2,5}(?:\/|$)/.test(pathname); // a host:port segment inside the path

  if (looksPoisoned) {
    // Build an absolute redirect to the real root using the request's own host,
    // so it works on any port and can never be resolved relatively.
    const host = req.headers.get("host") ?? req.nextUrl.host;
    const res = NextResponse.redirect(`http://${host}/`, 307);
    res.headers.set("Cache-Control", "no-store, must-revalidate");
    return res;
  }
  return NextResponse.next();
}

export const config = {
  // Exclude Next internals and *clean* API routes so they work normally. Stacked
  // paths like /IP:port/.../api/... start with the poisoned segment (not "api/"),
  // so they are still matched and bounced to root by the check above.
  matcher: ["/((?!_next/|api/|favicon.ico).*)"],
};
