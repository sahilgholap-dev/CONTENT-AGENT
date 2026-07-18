"""One-time migration: mark existing Supabase users as portal admins.

After the portal split, every /api route requires app_metadata.role == 'admin'.
Existing users created by hand in the Supabase dashboard have no role and
would be locked out. Run this ONCE (needs SUPABASE_URL +
SUPABASE_SERVICE_ROLE_KEY in the environment or .env):

    uv run python scripts/grant_admin_roles.py            # dry run (prints plan)
    uv run python scripts/grant_admin_roles.py --apply    # actually set roles

Users that already have a role are left untouched.
"""

from __future__ import annotations

import sys

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

from casinogurus_ai_content_engine___daily_5_topic_batch import supabase_admin as sb


def main() -> None:
    apply = "--apply" in sys.argv
    users = sb.list_users()
    if not users:
        print("No auth users found.")
        return
    for u in users:
        current = (u.get("app_metadata") or {}).get("role")
        label = f"{u['email']} ({u['id'][:8]}…)"
        if current:
            print(f"  skip  {label} — already role={current!r}")
            continue
        if apply:
            sb.set_role(u["id"], "admin")
            print(f"  SET   {label} — role=admin")
        else:
            print(f"  would set {label} — role=admin (dry run)")
    if not apply:
        print("\nDry run only. Re-run with --apply to write the roles.")


if __name__ == "__main__":
    main()
