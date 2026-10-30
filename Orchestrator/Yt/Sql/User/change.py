from pathlib import Path
from typing import Any

def domain_deactivation(db_path: Union[str, Path], id_domain: int, cascade: bool = False) -> None:
    """
    Deactivate a Domain.
    By default: ONLY this domain is deactivated (no cascade).
    If cascade=True: ALL subdomains belonging to this domain are automatically deactivated.
    """
    path = Path(db_path)
    con = sqlite3.connect(path)
    con.execute("PRAGMA foreign_keys = ON")
    cur = con.cursor()

    # 1. Deactivate the domain itself
    cur.execute("UPDATE Domains SET active = 0 WHERE id_domain = ?", (id_domain,))
    affected = cur.rowcount

    if affected == 0:
        con.close()
        raise ValueError(f"Domain with id_domain={id_domain} not found")

    # 2. Cascade to all subdomains (if requested)
    if cascade:
        cur.execute("""
            UPDATE SubDomains
            SET active = 0
            WHERE id_domain = ?
        """, (id_domain,))
        print(f"✓ Cascade deactivated {cur.rowcount} subdomains")

    con.commit()
    con.close()
    print(f"✓ Domain id={id_domain} deactivated successfully")


def subdomain_deactivation(db_path: Union[str, Path], id_subdomain: int) -> None:
    """
    Deactivate a single Subdomain.
    This operation is NON-CASCADING.
    - No effect on the domain or any other subdomains.
    - No effect on Channels using this subdomain.
    """
    path = Path(db_path)
    con = sqlite3.connect(path)
    con.execute("PRAGMA foreign_keys = ON")
    cur = con.cursor()

    cur.execute("UPDATE SubDomains SET active = 0 WHERE id_subdomain = ?", (id_subdomain,))
    affected = cur.rowcount

    if affected == 0:
        con.close()
        raise ValueError(f"Subdomain with id_subdomain={id_subdomain} not found")

    con.commit()
    con.close()
    print(f"✓ Subdomain id={id_subdomain} deactivated successfully")

def change_domainNsubdomain(
    username: str,
    channel_ids: list[int],
    domain_name: str | None = None,
    subdomain_name: str | None = None
) -> dict[str, Any]:
    """
    Unified write operation.
    - If domain_name exists → MERGE all channels under it.
    - If domain_name does NOT exist → CREATE it (and optionally subdomain).
    - Then assign ALL channels to the chosen domain/subdomain.
    - If after the assign no channels remain linked to the old domain, it is automatically DELETED.
    """
    db_path = (Path(db_dir) if db_dir else Path.cwd()) / f"{username}.db"
    if not db_path.is_file():
        raise FileNotFoundError(f"User database not found: {db_path}")

    with _db_connection(db_path, readonly=False) as conn:
        try:
            domain_id: int | None = None
            old_id: int | None = None
            operation: str = "create"

            # === 1. Resolve the domain (merge or create) ===
            if domain_name:
                domain_name = domain_name.strip()
                if domain_name:
                    domain_id = _get_or_create_domain(conn, domain_name)
                    if domain_id is None:
                        raise ValueError("Domain creation failed")
            else:
                raise ValueError("At least one of domain_name or subdomain_name must be provided")

            # === 2. Resolve the subdomain (merge or create) ===
            if subdomain_name:
                subdomain_name = subdomain_name.strip()
                if subdomain_name:
                    subdomain_id = _get_or_create_subdomain(conn, subdomain_name)
                    # link to the chosen domain (safe with new schema)
                    conn.execute(
                        "UPDATE SubDomains SET id_domain = ? WHERE id_subdomain = ?",
                        (domain_id, subdomain_id)
                    )
                else:
                    subdomain_id = None
            else:
                subdomain_id = None

            # === 3. Assign ALL channels ===
            updates: list[str] = []
            params: list[Any] = []
            if domain_id is not None:
                updates.append("id_domain = ?")
                params.append(domain_id)
            if subdomain_id is not None:
                updates.append("id_subdomain = ?")
                params.append(subdomain_id)
            if updates:
                for ch_id in channel_ids:
                    conn.execute(
                        f"UPDATE Channel SET {', '.join(updates)} WHERE id_channel = ?",
                        [*params, ch_id]
                    )

            # === 4. Cleanup: delete domain if no channels left under it ===
            if domain_id is not None:
                cur = conn.execute(
                    """
                    SELECT COUNT(*) as cnt FROM Channel
                    WHERE id_subdomain IN (
                        SELECT id_subdomain FROM SubDomains WHERE id_domain = ?
                    )
                    UNION
                    SELECT COUNT(*) as cnt FROM Channel
                    WHERE id_subdomain IS NULL
                    """,
                    (domain_id,)
                )
                if cur.fetchone()["cnt"] == 0:
                    conn.execute("DELETE FROM Domains WHERE id_domain = ?", (domain_id,))
                    operation = "merged_and_deleted"

            conn.commit()
            return {
                "status": "success",
                "operation": operation,
                "domain": domain_name,
                "subdomain": subdomain_name,
                "channel_ids": channel_ids
            }

        except Exception:
            conn.rollback()
            raise
