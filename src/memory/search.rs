use super::now;
use anyhow::{bail, Result};

use super::{Layer, MemoryRecord, MemoryStatus};
pub(super) fn fts_query(query: &str) -> Result<String> {
    if query.chars().count() > 512 {
        bail!("search query exceeds 512 characters");
    }
    // OR-join every token so FTS5/bm25 can rank partial matches: a natural
    // question such as "what websocket authentication do you know?" must still
    // retrieve a record that only shares some of its terms, instead of
    // requiring every token to be present.
    Ok(query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|x| !x.is_empty())
        .map(|x| format!("\"{}\"", x.replace('"', "")))
        .collect::<Vec<_>>()
        .join(" OR "))
}
pub(super) fn rank_score(bm25: f64, r: &MemoryRecord) -> f64 {
    let relevance = (-bm25 * 1_000_000.0).clamp(0.0, 1.0);
    let age_days = ((now() - r.updated_at).max(0) as f64) / 86400.0;
    let recency = 1.0 / (1.0 + age_days / 30.0);
    let scope = match r.layer {
        Layer::Private => 0.45,
        Layer::Group => 0.4,
        Layer::Persona => 0.3,
        Layer::Global => 0.2,
        Layer::Archive => 0.1,
        Layer::RecentConversation => 0.5,
    };
    relevance
        + f64::from(r.importance) / 100.0
        + recency * 0.2
        + scope
        + if r.status == MemoryStatus::Active {
            0.2
        } else {
            0.0
        }
}
