mod error;
mod protocol;
mod routes;
mod websocket;

use std::{
    net::{IpAddr, Ipv4Addr, SocketAddr},
    sync::Arc,
};

use anyhow::Result;
use axum::Router;
use tokio::{net::TcpListener, sync::watch};

use crate::core::HivemindCore;

pub fn router(core: Arc<HivemindCore>, shutdown: watch::Receiver<bool>) -> Router {
    routes::router(core, shutdown)
}

pub async fn serve(core: Arc<HivemindCore>, port: u16) -> Result<()> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let listener = TcpListener::bind(address).await?;
    let address = listener.local_addr()?;
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let app = router(Arc::clone(&core), shutdown_rx);

    println!("API listening on http://{address} (WebSocket: ws://{address}/api/v1/ws)");
    let serve_result = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            if tokio::signal::ctrl_c().await.is_err() {
                eprintln!("API shutdown signal error");
            }
            println!("API shutting down");
            let _ = shutdown_tx.send(true);
        })
        .await;
    core.shutdown().await;
    serve_result?;
    println!("API stopped");
    Ok(())
}
