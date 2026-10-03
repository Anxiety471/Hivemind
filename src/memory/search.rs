use super::now;
use anyhow::{bail, Result};

use super::{Caller, Layer, MemoryRecord, MemoryStatus};

/// Rooms an Archive search must cover for `caller`: the caller's own room
/// first, then the parent room of a thread caller when it is non-empty and
/// different. De-duplicated so one room is never queried twice, which also
/// guarantees a room's messages are not merged twice when a (host-set) parent
/// happens to equal the own room.
pub(super) fn archive_rooms(caller: &Caller) -> Vec<String> {
    let mut rooms = Vec::with_capacity(2);
    rooms.push(caller.room_id.clone());
    if !caller.parent_room_id.is_empty() && !rooms.contains(&caller.parent_room_id) {
        rooms.push(caller.parent_room_id.clone());
    }
    rooms
}

/// Most distinct terms sent to FTS5; longer questions keep their first terms.
const MAX_QUERY_TERMS: usize = 16;

/// Words that match most rows and carry no ranking signal.
const STOPWORDS: &[&str] = &[
    "a", "about", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "can", "did",
    "do", "does", "for", "from", "had", "has", "have", "how", "i", "if", "in", "is", "it", "its",
    "me", "my", "of", "on", "or", "our", "that", "the", "their", "them", "then", "there", "these",
    "this", "to", "was", "we", "were", "what", "when", "where", "which", "who", "why", "will",
    "with", "would", "you", "your",
];

/// Distinct, lowercased, stopword-free query terms (capped), in query order.
pub(super) fn fts_terms(query: &str) -> Result<Vec<String>> {
    if query.chars().count() > 512 {
        bail!("search query exceeds 512 characters");
    }
    let mut all: Vec<String> = Vec::new();
    for token in query
        .split(|c: char| !c.is_alphanumeric())
        .filter(|x| !x.is_empty())
    {
        let token = token.to_lowercase();
        if !all.contains(&token) {
            all.push(token);
        }
    }
    // Drop stopwords unless nothing else is left, so a query made only of
    // common words still behaves as before.
    let informative: Vec<&String> = all
        .iter()
        .filter(|token| !STOPWORDS.contains(&token.as_str()))
        .collect();
    let chosen: Vec<&String> = if informative.is_empty() {
        all.iter().collect()
    } else {
        informative
    };
    Ok(chosen.into_iter().take(MAX_QUERY_TERMS).cloned().collect())
}

/// OR-join every term so FTS5/bm25 can rank partial matches: a natural
/// question such as "what websocket authentication do you know?" must still
/// retrieve a record that only shares some of its terms, instead of
/// requiring every token to be present.
pub(super) fn fts_query(terms: &[String]) -> String {
    terms
        .iter()
        .map(|token| format!("\"{token}\""))
        .collect::<Vec<_>>()
        .join(" OR ")
}

/// How many of `terms` occur as whole words in `text` (a cheap, bounded
/// stand-in for bm25 over an already-limited candidate set).
pub(super) fn matched_terms(terms: &[String], text: &str) -> usize {
    let words: std::collections::HashSet<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect();
    terms
        .iter()
        .filter(|term| words.contains(term.as_str()))
        .count()
}

/// `bm25` is negative and more negative means a stronger match. Map the
/// strength monotonically into `[0, 1)` so bm25 ordering is never flattened.
pub(super) fn rank_score(bm25: f64, r: &MemoryRecord) -> f64 {
    let strength = (-bm25).max(0.0);
    let relevance = strength / (1.0 + strength);
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
