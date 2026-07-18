import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// NOTE: In this Next.js version the `middleware` convention was renamed to
// `proxy` (see node_modules/next/dist/docs/.../file-conventions/proxy.md).
// This runs on the Node.js runtime by default and guards every page: it
// refreshes the Supabase session cookie, redirects unauthenticated users to
// /login, and routes by portal role. The role lives in app_metadata (only
// settable server-side via the Supabase Admin API), so it can't be forged:
//   role === "admin"  -> /admin/*   (internal team)
//   role === "client" -> /portal/*  (client logins, scoped to their client_id)
// The API is separately protected by JWT + role verification on FastAPI, so
// this is defence-in-depth for the dashboard pages.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isLoginPage = path.startsWith("/login");

  const redirect = (pathname: string) => {
    const url = request.nextUrl.clone();
    url.pathname = pathname;
    return NextResponse.redirect(url);
  };

  if (!user && !isLoginPage) return redirect("/login");
  if (!user) return response;

  // Pre-migration users (no role yet) are the internal team -> treat as admin.
  const role = (user.app_metadata as Record<string, unknown> | null)?.role ?? "admin";
  const home = role === "client" ? "/portal" : "/admin";

  if (isLoginPage || path === "/") return redirect(home);
  if (role === "client" && !path.startsWith("/portal")) return redirect(home);
  if (role !== "client" && path.startsWith("/portal")) return redirect(home);

  return response;
}

export const config = {
  // Run on all routes except static assets and image files.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.svg$).*)"],
};
