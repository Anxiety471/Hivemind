use anyhow::{bail, Context, Result};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::{self, Command},
    thread,
};

const REPO: &str = "Anxiety471/Hivemind";
const RELEASES_LATEST: &str = "https://github.com/Anxiety471/Hivemind/releases/latest";
const TARGET: &str = "x86_64-unknown-linux-gnu";

pub(super) fn update(check_only: bool) -> Result<()> {
    ensure_supported_platform()?;

    let current = env!("CARGO_PKG_VERSION");
    let latest = latest_release_tag()?;

    if !is_newer(current, &latest)? {
        println!("Hivemind v{current} is already up to date.");
        return Ok(());
    }

    println!("Update available: v{current} -> {latest}");
    if check_only {
        return Ok(());
    }

    install_release(&latest)?;
    println!("Updated Hivemind v{current} -> {latest}");
    Ok(())
}

pub(super) fn spawn_update_notice() {
    if env::var_os("HIVEMIND_NO_UPDATE_CHECK").is_some() {
        return;
    }

    thread::spawn(|| {
        let current = env!("CARGO_PKG_VERSION");
        let Ok(latest) = latest_release_tag() else {
            return;
        };
        if matches!(is_newer(current, &latest), Ok(true)) {
            eprintln!(
                "\nUpdate available: v{current} -> {latest}. Run `hivemind update` to install it.\n"
            );
        }
    });
}

fn ensure_supported_platform() -> Result<()> {
    if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Ok(())
    } else {
        bail!("self-update currently supports Linux x86_64 only")
    }
}

fn latest_release_tag() -> Result<String> {
    let output = Command::new("curl")
        .args([
            "-fsSL",
            "--max-time",
            "8",
            "-o",
            "/dev/null",
            "-w",
            "%{url_effective}",
            RELEASES_LATEST,
        ])
        .output()
        .context("curl is required to check for Hivemind updates")?;

    if !output.status.success() {
        bail!("failed to resolve the latest Hivemind release");
    }

    let final_url = String::from_utf8(output.stdout).context("GitHub returned an invalid URL")?;
    let tag = final_url
        .trim()
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .filter(|part| part.starts_with('v'))
        .context("could not determine the latest Hivemind release tag")?;

    parse_version(tag)?;
    Ok(tag.to_owned())
}

fn install_release(tag: &str) -> Result<()> {
    let asset = format!("hivemind-{TARGET}.tar.gz");
    let base = format!("https://github.com/{REPO}/releases/download/{tag}");
    let temp_dir = temp_update_dir();
    fs::create_dir_all(&temp_dir)
        .with_context(|| format!("failed to create {}", temp_dir.display()))?;

    let result = install_release_inner(&temp_dir, &base, &asset);
    let _ = fs::remove_dir_all(&temp_dir);
    result
}

fn install_release_inner(temp_dir: &Path, base: &str, asset: &str) -> Result<()> {
    let archive = temp_dir.join(asset);
    let checksum = temp_dir.join(format!("{asset}.sha256"));

    download(&format!("{base}/{asset}"), &archive)?;
    download(&format!("{base}/{asset}.sha256"), &checksum)?;
    verify_checksum(&archive, &checksum)?;

    let status = Command::new("tar")
        .args(["-xzf"])
        .arg(&archive)
        .arg("-C")
        .arg(temp_dir)
        .status()
        .context("tar is required to unpack Hivemind")?;
    if !status.success() {
        bail!("failed to unpack the Hivemind release");
    }

    let candidate = temp_dir.join("hivemind");
    if !candidate.is_file() {
        bail!("release archive did not contain a hivemind binary");
    }

    replace_current_executable(&candidate)
}

fn download(url: &str, destination: &Path) -> Result<()> {
    let status = Command::new("curl")
        .args(["-fL", "--retry", "3", "--retry-delay", "1", "-o"])
        .arg(destination)
        .arg(url)
        .status()
        .with_context(|| format!("failed to start curl for {url}"))?;

    if !status.success() {
        bail!("failed to download {url}");
    }
    Ok(())
}

fn verify_checksum(archive: &Path, checksum: &Path) -> Result<()> {
    let expected_text = fs::read_to_string(checksum)
        .with_context(|| format!("failed to read {}", checksum.display()))?;
    let expected = expected_text
        .split_whitespace()
        .next()
        .context("release checksum file was empty")?;

    let output = Command::new("sha256sum")
        .arg(archive)
        .output()
        .context("sha256sum is required to verify the Hivemind download")?;
    if !output.status.success() {
        bail!("failed to calculate the release checksum");
    }

    let actual_text =
        String::from_utf8(output.stdout).context("sha256sum returned invalid output")?;
    let actual = actual_text
        .split_whitespace()
        .next()
        .context("sha256sum returned no checksum")?;

    if expected != actual {
        bail!("checksum verification failed; refusing to replace Hivemind");
    }
    Ok(())
}

fn replace_current_executable(candidate: &Path) -> Result<()> {
    let current = env::current_exe().context("failed to locate the running Hivemind binary")?;
    let parent = current
        .parent()
        .context("running Hivemind binary has no parent directory")?;
    let staged = parent.join(format!(".hivemind-update-{}", process::id()));

    fs::copy(candidate, &staged).with_context(|| {
        format!(
            "failed to stage update next to {}; check directory permissions",
            current.display()
        )
    })?;

    let permissions = fs::metadata(&current)
        .with_context(|| format!("failed to inspect {}", current.display()))?
        .permissions();
    fs::set_permissions(&staged, permissions)
        .with_context(|| format!("failed to set permissions on {}", staged.display()))?;

    if let Err(error) = fs::rename(&staged, &current) {
        let _ = fs::remove_file(&staged);
        return Err(error).with_context(|| {
            format!(
                "failed to replace {}; check directory permissions",
                current.display()
            )
        });
    }

    Ok(())
}

fn temp_update_dir() -> PathBuf {
    env::temp_dir().join(format!("hivemind-update-{}", process::id()))
}

fn is_newer(current: &str, latest: &str) -> Result<bool> {
    Ok(parse_version(latest)? > parse_version(current)?)
}

fn parse_version(value: &str) -> Result<(u64, u64, u64)> {
    let core = value
        .trim()
        .strip_prefix('v')
        .unwrap_or(value.trim())
        .split('-')
        .next()
        .unwrap_or_default();
    let mut parts = core.split('.');

    let major = parts
        .next()
        .context("missing major version")?
        .parse()
        .with_context(|| format!("invalid version: {value}"))?;
    let minor = parts
        .next()
        .context("missing minor version")?
        .parse()
        .with_context(|| format!("invalid version: {value}"))?;
    let patch = parts
        .next()
        .context("missing patch version")?
        .parse()
        .with_context(|| format!("invalid version: {value}"))?;

    if parts.next().is_some() {
        bail!("invalid version: {value}");
    }

    Ok((major, minor, patch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_release_versions() {
        assert!(is_newer("0.1.0", "v0.1.1").unwrap());
        assert!(is_newer("0.9.9", "v1.0.0").unwrap());
        assert!(!is_newer("0.1.1", "v0.1.1").unwrap());
        assert!(!is_newer("0.2.0", "v0.1.9").unwrap());
    }

    #[test]
    fn rejects_invalid_release_versions() {
        assert!(parse_version("latest").is_err());
        assert!(parse_version("v1.2").is_err());
    }
}
