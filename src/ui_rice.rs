//! The hive's saved web UI rice.
//!
//! Preset ids match the browser (`frontend/src/rice.ts`). A custom rice carries
//! both palettes. The file lives in the data directory, so every browser that
//! talks to this server shares one saved look. Unsaved tweaks stay in the browser.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const PRESETS: &[&str] = &[
    "hive",
    "catppuccin",
    "gruvbox",
    "nord",
    "tokyonight",
    "rosepine",
    "kanagawa",
    "dracula",
    "everforest",
    "oxocarbon",
    "solarized",
    "matrix",
];

const MAX_CUSTOM: usize = 40;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UiPalette {
    pub bg: String,
    pub panel: String,
    #[serde(rename = "panel2")]
    pub panel2: String,
    pub sidebar: String,
    #[serde(rename = "sidebarText")]
    pub sidebar_text: String,
    pub text: String,
    pub muted: String,
    pub border: String,
    pub accent: String,
    #[serde(rename = "accentInk")]
    pub accent_ink: String,
    #[serde(rename = "accentSoft")]
    pub accent_soft: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UiRice {
    pub id: String,
    pub name: String,
    pub blurb: String,
    pub appearance: String,
    pub font: String,
    pub radius: u8,
    pub density: String,
    pub light: UiPalette,
    pub dark: UiPalette,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UiRiceFile {
    pub selected_id: String,
    #[serde(default)]
    pub custom: Vec<UiRice>,
}

impl UiRiceFile {
    pub fn parse(value: &Value) -> Result<Self, String> {
        let mut doc: Self = serde_json::from_value(value.clone()).map_err(|_| {
            "rice needs selected_id and custom rices, each with a name and light and dark palettes"
                .to_owned()
        })?;
        doc.normalize()?;
        Ok(doc)
    }

    fn normalize(&mut self) -> Result<(), String> {
        if !valid_id(&self.selected_id) {
            return Err("selected_id must be a short id".into());
        }
        if self.custom.len() > MAX_CUSTOM {
            return Err(format!("you can keep up to {MAX_CUSTOM} rices"));
        }
        let mut seen = Vec::new();
        for rice in &mut self.custom {
            rice.normalize()?;
            if seen.contains(&rice.id) {
                return Err(format!("duplicate rice id '{}'", rice.id));
            }
            if PRESETS.contains(&rice.id.as_str()) {
                return Err(format!("'{}' is a preset id", rice.id));
            }
            seen.push(rice.id.clone());
        }
        let known = PRESETS.contains(&self.selected_id.as_str())
            || self.custom.iter().any(|rice| rice.id == self.selected_id);
        if !known {
            return Err(format!("unknown rice '{}'", self.selected_id));
        }
        Ok(())
    }
}

impl UiRice {
    fn normalize(&mut self) -> Result<(), String> {
        if !valid_id(&self.id) {
            return Err("rice id must be a short id".into());
        }
        self.name = clean_text(&self.name, 40).ok_or("use a rice name up to 40 characters")?;
        self.blurb = clean_text(&self.blurb, 120).unwrap_or_default();
        self.appearance = one_of(&self.appearance, &["system", "light", "dark"], "appearance")?;
        self.font = one_of(&self.font, &["sans", "serif", "mono"], "font")?;
        self.density = one_of(&self.density, &["compact", "cozy", "roomy"], "density")?;
        if self.radius > 24 {
            return Err("radius must be from 0 to 24".into());
        }
        normalize_palette(&mut self.light)?;
        normalize_palette(&mut self.dark)?;
        Ok(())
    }
}

fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    match chars.next() {
        Some(ch) if ch.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    id.len() <= 64 && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
}

fn clean_text(value: &str, max: usize) -> Option<String> {
    let trimmed = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.is_empty() || trimmed.chars().count() > max {
        return None;
    }
    if trimmed.chars().any(|ch| ch.is_control()) {
        return None;
    }
    Some(trimmed)
}

fn one_of(value: &str, allowed: &[&str], field: &str) -> Result<String, String> {
    if allowed.contains(&value) {
        Ok(value.to_owned())
    } else {
        Err(format!("{field} must be {}", allowed.join(", ")))
    }
}

fn normalize_palette(palette: &mut UiPalette) -> Result<(), String> {
    for color in [
        &mut palette.bg,
        &mut palette.panel,
        &mut palette.panel2,
        &mut palette.sidebar,
        &mut palette.sidebar_text,
        &mut palette.text,
        &mut palette.muted,
        &mut palette.border,
        &mut palette.accent,
        &mut palette.accent_ink,
        &mut palette.accent_soft,
    ] {
        *color = normalize_hex(color)?;
    }
    Ok(())
}

fn normalize_hex(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    let hex = trimmed.strip_prefix('#').unwrap_or(trimmed);
    if hex.len() == 6 && hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        return Ok(format!("#{}", hex.to_ascii_lowercase()));
    }
    Err(format!("colors need to be hex, like #e8a317 (got {value})"))
}

/// `data_dir/ui-rice.json`, guarded so two browsers can save without tearing the file.
pub struct UiRiceStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl UiRiceStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("ui-rice.json"),
            lock: Mutex::new(()),
        }
    }

    pub fn load(&self) -> Result<Option<UiRiceFile>> {
        let _guard = self.lock.lock().expect("rice lock poisoned");
        if !self.path.exists() {
            return Ok(None);
        }
        let raw = fs::read_to_string(&self.path)
            .with_context(|| format!("reading {}", self.path.display()))?;
        let value: Value = serde_json::from_str(&raw)
            .with_context(|| format!("parsing {}", self.path.display()))?;
        UiRiceFile::parse(&value)
            .map(Some)
            .map_err(|message| anyhow::anyhow!(message))
    }

    pub fn save(&self, doc: &UiRiceFile) -> Result<()> {
        let _guard = self.lock.lock().expect("rice lock poisoned");
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(doc)?)
            .with_context(|| format!("writing {}", tmp.display()))?;
        fs::rename(&tmp, &self.path)
            .with_context(|| format!("replacing {}", self.path.display()))?;
        Ok(())
    }

    pub fn clear(&self) -> Result<()> {
        let _guard = self.lock.lock().expect("rice lock poisoned");
        if self.path.exists() {
            fs::remove_file(&self.path)
                .with_context(|| format!("removing {}", self.path.display()))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn palette(accent: &str) -> Value {
        json!({
            "bg": "#111215",
            "panel": "#18191d",
            "panel2": "#1d1e23",
            "sidebar": "#0b0c0e",
            "sidebarText": "#c9cad1",
            "text": "#e8e8ec",
            "muted": "#9497a1",
            "border": "#2a2c32",
            "accent": accent,
            "accentInk": "#1c1d21",
            "accentSoft": "#3a2e12"
        })
    }

    fn custom(id: &str) -> Value {
        json!({
            "id": id,
            "name": "Phosphor",
            "blurb": "Based on Matrix.",
            "appearance": "dark",
            "font": "mono",
            "radius": 2,
            "density": "compact",
            "light": palette("#1b8f2a"),
            "dark": palette("#39FF14")
        })
    }

    #[test]
    fn preset_selection_and_custom_rice_round_trip() {
        let dir = std::env::temp_dir().join(format!("hivemind-rice-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = UiRiceStore::new(&dir);
        assert!(store.load().unwrap().is_none());

        let preset = UiRiceFile::parse(&json!({"selected_id": "nord", "custom": []})).unwrap();
        store.save(&preset).unwrap();
        assert_eq!(store.load().unwrap().unwrap().selected_id, "nord");

        let saved = UiRiceFile::parse(
            &json!({"selected_id": "custom-phosphor", "custom": [custom("custom-phosphor")]}),
        )
        .unwrap();
        assert_eq!(saved.custom[0].dark.accent, "#39ff14");
        store.save(&saved).unwrap();
        let loaded = store.load().unwrap().unwrap();
        assert_eq!(loaded, saved);

        store.clear().unwrap();
        assert!(store.load().unwrap().is_none());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_unknown_ids_bad_colors_and_preset_collisions() {
        assert!(UiRiceFile::parse(&json!({"selected_id": "nope", "custom": []})).is_err());
        assert!(UiRiceFile::parse(&json!({"selected_id": "hive"})).is_ok());
        let mut bad = custom("custom-phosphor");
        bad["dark"]["accent"] = json!("green");
        assert!(
            UiRiceFile::parse(&json!({"selected_id": "custom-phosphor", "custom": [bad]})).is_err()
        );
        assert!(
            UiRiceFile::parse(&json!({"selected_id": "nord", "custom": [custom("nord")]})).is_err()
        );
        assert!(UiRiceFile::parse(
            &json!({"selected_id": "custom-a", "custom": [custom("custom-b")]})
        )
        .is_err());
    }
}
