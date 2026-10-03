mod access;
mod app;
mod args;
mod groups;
mod issues;
mod render;
mod shell;
mod tasks;
mod update;

pub(super) async fn entry() {
    app::entry().await;
}
