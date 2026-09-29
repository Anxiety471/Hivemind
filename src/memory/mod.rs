//! Deterministic, model-independent durable memory storage and policy.
mod archive;
mod model;
mod policy;
mod search;
mod service;
mod store;

#[cfg(test)]
mod tests;

pub use model::*;
pub use service::MemoryService;
pub use store::MemoryStore;

use archive::*;
use policy::*;
use search::*;
use std::time::{SystemTime, UNIX_EPOCH};

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn new_id() -> String {
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64;
    let sequence = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // Time-first, fixed-width ids keep archive ordering deterministic and let
    // rows sort chronologically by id. The per-process sequence plus pid makes
    // ids unique across concurrent Hivemind processes, which previously
    // collided when either minted a runtime epoch within the same second.
    format!("memory-{nanos:020}-{sequence:06}-{}", std::process::id())
}
