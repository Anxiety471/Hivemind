mod error;
mod protocol;
mod routes;
mod websocket;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use anyhow::Result;
use axum::Router;
use tokio::{net::TcpListener, sync::watch};

use crate::config::HivemindConfig;

pub fn router(config: HivemindConfig, shutdown: watch::Receiver<bool>) -> Router {
    routes::router(config, shutdown)
}

pub async fn serve(config: HivemindConfig, port: u16) -> Result<()> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let listener = TcpListener::bind(address).await?;
    let address = listener.local_addr()?;
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let app = router(config, shutdown_rx);

    println!("API listening on http://{address} (WebSocket: ws://{address}/api/v1/ws)");
    axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            if let Err(error) = tokio::signal::ctrl_c().await {
                eprintln!("API shutdown signal error: {error}");
            }
            println!("API shutting down");
            let _ = shutdown_tx.send(true);
        })
        .await?;
    println!("API stopped");
    Ok(())
}
