use std::path::PathBuf;

use anyhow::Result;
use clap::Parser;
use hivemind::{api, config::HivemindConfig, core::HivemindCore};

#[derive(Debug, Parser)]
#[command(
    name = "hivemind-server",
    about = "Start the Hivemind HTTP and WebSocket API"
)]
struct Cli {
    #[arg(long, default_value = "hivemind.toml")]
    config: PathBuf,
    #[arg(long, default_value_t = 7474)]
    port: u16,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let config = HivemindConfig::load(&cli.config)?;
    let core = std::sync::Arc::new(HivemindCore::new(config, &cli.config)?);
    api::serve(core, cli.port).await
}
