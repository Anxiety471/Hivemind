mod setup;

mod cli;

/// glibc gives every thread its own malloc arena, so the long-lived room
/// caches end up scattered over several half-empty arenas and RSS grows with
/// history. One arena keeps it flat; contention is negligible next to SQLite
/// and model latency.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn limit_malloc_arenas() {
    extern "C" {
        fn mallopt(param: i32, value: i32) -> i32;
    }
    const M_ARENA_MAX: i32 = -8;
    // SAFETY: plain libc call made before any thread is spawned.
    unsafe {
        mallopt(M_ARENA_MAX, 1);
    }
}

#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
fn limit_malloc_arenas() {}

fn main() {
    limit_malloc_arenas();
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("failed to start the async runtime")
        .block_on(cli::entry());
}
