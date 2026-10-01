mod auth;
mod jobs;
pub use auth::ServerConfig;
mod chat_groups;
mod cors;
mod error;
mod protocol;
mod rooms;
mod routes;
mod runtime;
mod setup;
mod tasks;
mod websocket;
mod workspaces;

use std::{net::SocketAddr, sync::Arc};

use anyhow::Result;
use axum::Router;
use tokio::{net::TcpListener, sync::watch};

use crate::core::HivemindCore;

pub fn router(core: Arc<HivemindCore>, shutdown: watch::Receiver<bool>) -> Router {
    routes::router(core, shutdown)
}

/// Run durable asynchronous chat jobs for an embedded router. The core owns
/// shutdown; this worker holds the same exclusive data-directory lock as serve.
pub async fn run_jobs(core: Arc<HivemindCore>) -> Result<()> {
    let _worker_lock = crate::execution::worker_lock(core.data_dir())?;
    jobs::run(core).await;
    Ok(())
}

pub async fn serve(core: Arc<HivemindCore>, port: u16) -> Result<()> {
    let _worker_lock = crate::execution::worker_lock(core.data_dir())?;
    let address = SocketAddr::new(core.config().server.bind, port);
    let _auth = auth::Auth::load(&core.config().server)?;
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
    let jobs = tokio::spawn(jobs::run(core.clone()));
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
    let _ = jobs.await;
    serve_result?;
    println!("API stopped");
    Ok(())
}

#[cfg(test)]
mod execution_tests;
