//! Storage layer — SQLite primitives + the per-entity named queries.
//! Plan §5.3 + D4/D5/D6.

pub mod backup;
pub mod db;
pub mod import_merge;
pub mod migrations;
pub mod queries;
pub mod query;
pub mod schema;

pub use backup::{backup, restore, validate_backup_source};
pub use db::{open, open_in_memory};
pub use import_merge::{import_merge, ImportReport};
pub use queries::*;

use std::fs::File;

use rusqlite::Connection;

use crate::error::Result;

/// Exclusive advisory lock on a `<db>.init.lock` sidecar, serializing `init_db`
/// across processes (app/CLI/MCP cold-start one file) — `busy_timeout` covers
/// row writes, not a racer mid-DDL. An flock, NOT `BEGIN IMMEDIATE`: migrations
/// can't nest inside one transaction (some carry their own BEGIN/COMMIT).
/// `None` for in-memory/temp DBs; released when the returned `File` drops.
fn init_lock(conn: &Connection) -> Result<Option<File>> {
    let Some(db_path) = conn.path().filter(|p| !p.is_empty()) else {
        return Ok(None);
    };
    let mut lock_path = std::ffi::OsString::from(db_path);
    lock_path.push(".init.lock");
    let file = File::create(&lock_path)?;
    file.lock()?;
    Ok(Some(file))
}

/// Last DB_VERSION row; `None` on a fresh DB or one predating the table.
fn last_db_version(conn: &Connection) -> Option<String> {
    conn.query_row(
        "SELECT VERSION FROM DB_VERSION ORDER BY VERSION_FK DESC LIMIT 1",
        [],
        |r| r.get(0),
    )
    .ok()
}

/// Any user table besides the bookkeeping ones — distinguishes a fresh install
/// (nothing to back up) from an existing DB about to be migrated.
fn has_user_tables(conn: &Connection) -> Result<bool> {
    let n: i64 = conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' \
         AND name NOT LIKE 'sqlite_%' AND name != 'SCHEMA_MIGRATION_EVENTS'",
        [],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

/// Full startup init, FK-safe order: pre-schema dedup → tables → idempotent
/// migrations → views. Migrations MUST precede views (views select columns the
/// migrations add); the PROJECT_TO_PAPER dedup MUST precede tables (after
/// PAPER_TO_READING's composite FK exists its DML fails with "foreign key
/// mismatch"). The whole run holds the cross-process `init_lock` above.
///
/// On a version transition (last DB_VERSION row ≠ this build) the pass is
/// bracketed: pre-migration file copy first (existing file-backed DBs only),
/// then a SCHEMA_MIGRATION_EVENTS row recording how it went. Success stamps
/// DB_VERSION with the build version, so the bracket runs once per upgrade,
/// not per launch.
pub fn init_db(conn: &Connection) -> Result<()> {
    let _lock = init_lock(conn)?;
    // Events table before any other DDL: a failing legacy upgrade below must
    // still get its row.
    migrations::schema_migration_events_table(conn)?;

    let target = env!("CARGO_PKG_VERSION");
    let from = last_db_version(conn);
    let pending = from.as_deref() != Some(target);
    // Backup failure aborts the run: migrating without the recovery point is
    // the exact failure mode this exists to prevent.
    let report_path = match (pending && has_user_tables(conn)?)
        .then(|| conn.path().filter(|p| !p.is_empty()))
        .flatten()
    {
        Some(p) => {
            let db_path = std::path::PathBuf::from(p);
            let from = from.as_deref().unwrap_or("unknown");
            Some(backup::pre_migration_backup(conn, &db_path, from)?.path)
        }
        None => None,
    };

    let result = (|| {
        migrations::dedup_project_to_paper(conn)?;
        schema::apply_tables(conn)?;
        migrations::run_migrations(conn)?;
        schema::apply_views(conn)
    })();

    if pending {
        let insert = conn.execute(
            "INSERT INTO SCHEMA_MIGRATION_EVENTS \
             (FROM_VERSION, TARGET_VERSION, STATUS, REPORT_PATH) VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                from,
                target,
                // failed-restored is reserved for a future auto-restore flow.
                if result.is_ok() {
                    "succeeded"
                } else {
                    "failed-unrestored"
                },
                report_path
                    .as_ref()
                    .map(|p| p.to_string_lossy().into_owned()),
            ],
        );
        if result.is_ok() {
            insert?;
            conn.execute(
                "INSERT OR IGNORE INTO DB_VERSION (VERSION) VALUES (?1)",
                [target],
            )?;
        }
        // On failure the migration error wins; the row insert is best-effort.
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn last_event(conn: &Connection) -> (Option<String>, String, String, Option<String>) {
        conn.query_row(
            "SELECT FROM_VERSION, TARGET_VERSION, STATUS, REPORT_PATH \
             FROM SCHEMA_MIGRATION_EVENTS ORDER BY EVENT_FK DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap()
    }

    fn event_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT COUNT(*) FROM SCHEMA_MIGRATION_EVENTS", [], |r| {
            r.get(0)
        })
        .unwrap()
    }

    /// A legacy upgrade writes one event row plus a pre-migration copy; a
    /// fresh install writes its row but no backup; a same-version relaunch
    /// writes neither.
    #[test]
    fn upgrade_writes_event_and_backup_fresh_install_writes_no_backup() {
        let dir = std::env::temp_dir().join(format!("linxiv-mig-events-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let target = env!("CARGO_PKG_VERSION");

        // Fresh install: event row, no backups dir.
        let fresh_dir = dir.join("fresh");
        std::fs::create_dir_all(&fresh_dir).unwrap();
        let conn = open(&fresh_dir.join("papers.db")).unwrap();
        init_db(&conn).unwrap();
        let (from, to, status, report) = last_event(&conn);
        assert_eq!(
            (from, to.as_str(), status.as_str(), report),
            (None, target, "succeeded", None)
        );
        assert!(
            !fresh_dir.join("backups").exists(),
            "fresh install must not write a backup"
        );
        let seq = |c: &Connection| -> i64 {
            c.query_row(
                "SELECT seq FROM sqlite_sequence WHERE name = 'DB_VERSION'",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        let before = seq(&conn);
        init_db(&conn).unwrap();
        assert_eq!(
            event_count(&conn),
            1,
            "same-version relaunch must not add a row"
        );
        assert_eq!(seq(&conn), before, "relaunch must not burn DB_VERSION ids");

        // Legacy upgrade: event row pointing at a real copy in backups/.
        let legacy_dir = dir.join("legacy");
        std::fs::create_dir_all(&legacy_dir).unwrap();
        let legacy_path = legacy_dir.join("papers.db");
        open(&legacy_path)
            .unwrap()
            .execute_batch(include_str!("../../sql/tables/DB_VERSION.sql"))
            .unwrap();
        let conn = open(&legacy_path).unwrap();
        init_db(&conn).unwrap();
        let (from, to, status, report) = last_event(&conn);
        assert_eq!(from.as_deref(), Some("0.1.2"));
        assert_eq!((to.as_str(), status.as_str()), (target, "succeeded"));
        let report = std::path::PathBuf::from(report.expect("upgrade must record its copy"));
        assert!(
            report.exists(),
            "REPORT_PATH must point at the copy on disk"
        );
        assert!(report.starts_with(legacy_dir.join("backups")));
        // The copy is a pre-migration snapshot: still at 0.1.2, no new tables.
        let copy = rusqlite::Connection::open(&report).unwrap();
        let v: String = copy
            .query_row(
                "SELECT VERSION FROM DB_VERSION ORDER BY VERSION_FK DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, "0.1.2");
        // Success stamped DB_VERSION, so the next launch is a quiet no-op.
        assert_eq!(last_db_version(&conn).as_deref(), Some(target));
        init_db(&conn).unwrap();
        assert_eq!(event_count(&conn), 1);
        assert_eq!(
            backup::list_pre_migration_backups(&legacy_path)
                .unwrap()
                .len(),
            1
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A migration that blows up mid-upgrade still leaves an honest
    /// failed-unrestored row and the pre-migration copy, and does NOT stamp
    /// DB_VERSION — the next launch retries the upgrade.
    #[test]
    fn failed_upgrade_still_writes_event_row_and_keeps_backup() {
        let dir = std::env::temp_dir().join(format!("linxiv-mig-fail-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("papers.db");
        // Poisoned legacy shape: TAG without its TAG column makes migration 04's
        // SELECT fail after apply_tables no-ops on the existing table.
        let seed = open(&path).unwrap();
        seed.execute_batch(include_str!("../../sql/tables/DB_VERSION.sql"))
            .unwrap();
        seed.execute_batch("CREATE TABLE TAG (TAG_FK INTEGER PRIMARY KEY);")
            .unwrap();
        drop(seed);

        let conn = open(&path).unwrap();
        init_db(&conn).unwrap_err();

        let (from, to, status, report) = last_event(&conn);
        assert_eq!(from.as_deref(), Some("0.1.2"));
        assert_eq!(to, env!("CARGO_PKG_VERSION"));
        assert_eq!(status, "failed-unrestored");
        assert!(std::path::Path::new(&report.expect("failed upgrade keeps its copy")).exists());
        assert_eq!(
            last_db_version(&conn).as_deref(),
            Some("0.1.2"),
            "a failed upgrade must not stamp DB_VERSION"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Regression: 8 threads, each with its OWN file-backed connection to one
    /// shared DB file, race the full init path — separate connections exercise
    /// the same SQLite-level DDL race as separate cold-start processes. Without
    /// the init lock this fails nondeterministically ("foreign key mismatch",
    /// "vtable constructor failed", "trigger ... already exists"), so several
    /// rounds on fresh files make the failure reliable.
    #[test]
    fn concurrent_init_from_separate_connections_is_serialized() {
        let dir = std::env::temp_dir().join(format!("linxiv-init-race-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for round in 0..10 {
            let path = dir.join(format!("race-{round}.db"));
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(8));
            let handles: Vec<_> = (0..8)
                .map(|_| {
                    let path = path.clone();
                    let barrier = barrier.clone();
                    std::thread::spawn(move || -> Result<()> {
                        let conn = open(&path)?;
                        barrier.wait();
                        init_db(&conn)
                    })
                })
                .collect();
            for h in handles {
                h.join().unwrap().unwrap();
            }
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
