mod commands;
mod setup;

mod cli;

#[tokio::main]
async fn main() {
    cli::entry().await;
}
