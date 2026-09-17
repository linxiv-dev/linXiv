//! Group `zotero`: CSL JSON import. Export lives with the other project
//! exporters as `project export-zotero`, matching `export-bibtex`.

use clap::Subcommand;

use linxiv_core::service::paper_import;

use crate::ctx::Ctx;
use crate::output::{fail, output};

#[derive(Subcommand)]
pub enum ZoteroCmd {
    /// Import papers from a Zotero CSL JSON export
    Import {
        /// Path to the CSL JSON file
        file: String,
        /// Link imported papers to a project
        #[arg(long = "project-id")]
        project_id: Option<i64>,
    },
}

pub async fn run(cmd: ZoteroCmd, ctx: &mut Ctx) -> anyhow::Result<()> {
    match cmd {
        ZoteroCmd::Import { file, project_id } => {
            let text = match std::fs::read_to_string(&file) {
                Ok(t) => t,
                Err(e) => {
                    eprintln!("[zotero-import] {e}");
                    fail(e);
                }
            };
            match paper_import::import_zotero(&mut ctx.conn, &text, project_id) {
                Ok(receipt) => output(&receipt),
                Err(e) => fail(e),
            }
        }
    }
    Ok(())
}
