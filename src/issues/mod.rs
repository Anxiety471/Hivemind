//! Issue council: configured personas discuss what to build or fix next and
//! file those proposals. The backlog is not executed.
mod model;
mod runner;
mod service;
mod store;
mod tools;

#[cfg(test)]
mod tests;

pub use model::{
    pace_due, Issue, IssueError, IssueKind, IssueStatus, Pace, Round, Trigger, COUNCIL_ROOM,
};
pub use runner::{run_discussion, start_council, Scheduler};
pub use service::{resolve_members, write_config_section, IssuesService, DEFAULT_GOAL};
pub use store::IssueStore;
pub use tools::IssueTools;
