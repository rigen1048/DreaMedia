import sqlite3
from pathlib import Path
from typing import Union

from Model.sql import Schema

def sql_init(path: Union[str, Path]) -> None:
    """
    Creates SQLite DB with proper schema and CASCADE/SET NULL behavior.
    Now includes:
      - Hierarchical deactivation via SubDomainTree (domain -> subdomain)
      - When a Domain is deactivated (active=0), all its subdomains are automatically deactivated.
      - Deactivating a subdomain does NOT affect any other subdomain (even same name from different domains).
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)  # ensure dir exists
    con = sqlite3.connect(path)
    con.execute("PRAGMA foreign_keys = ON")
    cur = con.cursor()
    cur.executescript(Schema["Youtube_Schema"])
    con.commit()
    con.close()
    print(f"Database schema created/updated successfully at {path}")
