//! `tracing` setup for the importer.
//!
//! Mirrors the main app's env-filter + fmt style so operators can use
//! the same `RUST_LOG` knobs (e.g. `RUST_LOG=importer.db=warn`).

use tracing_subscriber::{fmt, prelude::*, EnvFilter};

pub(crate) fn init() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,importer=info"));
    tracing_subscriber::registry()
        .with(filter)
        .with(fmt::layer().with_target(true).with_thread_ids(false))
        .init();
}
