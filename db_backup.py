"""Back up a live revision database in a way that actually captures recent work.

The store runs in WAL mode, so the newest commits live in the `data.db-wal` sidecar
until a checkpoint. Copying `data.db` on its own with shutil.copy2 therefore produced
a backup that was missing exactly the recent work: a snapshot taken minutes after a
lesson was generated did not contain that lesson, which is what made an earlier
recovery attempt fail. The sqlite3 backup API writes one consistent copy including
whatever is still in the WAL.
"""
import os
import sqlite3


def backup_database(db_path, backup_path, quiet=False):
    """Write a consistent snapshot of `db_path` to `backup_path`; return the path."""
    if os.path.exists(backup_path):
        os.remove(backup_path)          # a stale copy must not be mistaken for this one
    src = sqlite3.connect(db_path)
    try:
        dst = sqlite3.connect(backup_path)
        try:
            src.backup(dst)
            dst.commit()
        finally:
            dst.close()
    finally:
        src.close()
    if not quiet:
        size = os.path.getsize(backup_path) / 1e6
        print(f"备份已写: {backup_path}（{size:.0f} MB，含 WAL 中未检查点的提交）")
    return backup_path
