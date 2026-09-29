mod app;
mod args;
mod groups;
mod render;
mod shell;

pub(super) async fn entry() {
    app::entry().await;
}
