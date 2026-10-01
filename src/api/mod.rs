mod chat_groups;
mod error;
mod protocol;
mod rooms;
mod routes;
mod tasks;
mod websocket;
mod workspaces;

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
    let scheduler = core
        .coordination()
        .enabled()
        .then(|| tokio::spawn(crate::coordination::Scheduler::new(Arc::clone(&core), None).run()));
    if scheduler.is_some() {
        println!("Coordination scheduler running");
    }
    let shutdown_core = Arc::clone(&core);
    let serve_result = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            if tokio::signal::ctrl_c().await.is_err() {
                eprintln!("API shutdown signal error");
            }
            println!("API shutting down");
            shutdown_core.shutdown().await;
            let _ = shutdown_tx.send(true);
        })
        .await;
    core.shutdown().await;
    if let Some(scheduler) = scheduler {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(10), scheduler).await;
    }
    serve_result?;
    println!("API stopped");
    Ok(())
}
