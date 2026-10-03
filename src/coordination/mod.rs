//! Autonomous agent coordination: durable tasks, agent messaging, dynamic
//! groups, host-bound tools, and a leased scheduler. Deterministic storage,
//! authorization, scheduling, and context assembly never require a model.
pub mod capsule;
mod deferred;
pub mod live;
pub mod model;
pub mod policy;
pub mod runner;
pub mod service;
pub mod store;
pub mod tools;
pub mod workspace;

#[cfg(test)]
mod e2e;
#[cfg(test)]
mod tests;

pub use model::{CoordError, CoordResult};
pub use runner::Scheduler;
pub use service::{wire_type, CoordinationService};
pub use tools::CoordinationTools;
