mod app;
mod args;
mod groups;
mod render;
mod shell;
mod access;
mod tasks;

pub(super) async fn entry() {
    app::entry().await;
}
