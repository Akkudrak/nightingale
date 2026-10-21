use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::error::NightingaleError;

const MANIFEST_NAME: &str = "manifest.json";

const FORMAT_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestEntry {
    pub name: String,
    pub length: u64,
    pub blake3: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    pub version: u32,
    pub file_hash: String,
    pub metadata: serde_json::Value,
    pub entries: Vec<ManifestEntry>,
}

impl Manifest {
    pub fn entry(&self, name: &str) -> Option<&ManifestEntry> {
        self.entries.iter().find(|e| e.name == name)
    }
}

fn short_blake3(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex()[..32].to_string()
}

fn zip_err(e: zip::result::ZipError) -> NightingaleError {
    NightingaleError::Other(format!("nge: {e}"))
}

pub fn build_nge(
    file_hash: &str,
    metadata: serde_json::Value,
    entries: &[(String, Vec<u8>)],
) -> Result<Vec<u8>, NightingaleError> {
    let manifest = Manifest {
        version: FORMAT_VERSION,
        file_hash: file_hash.to_string(),
        metadata,
        entries: entries
            .iter()
            .map(|(name, bytes)| ManifestEntry {
                name: name.clone(),
                length: bytes.len() as u64,
                blake3: short_blake3(bytes),
            })
            .collect(),
    };

    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Stored)
        .large_file(
            entries
                .iter()
                .any(|(_, b)| b.len() as u64 >= u32::MAX as u64),
        );
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));

    zip.start_file(MANIFEST_NAME, options).map_err(zip_err)?;
    zip.write_all(&serde_json::to_vec_pretty(&manifest)?)?;

    for (name, bytes) in entries {
        zip.start_file(name.as_str(), options).map_err(zip_err)?;
        zip.write_all(bytes)?;
    }

    Ok(zip.finish().map_err(zip_err)?.into_inner())
}

#[derive(Debug, Clone)]
pub struct NgeFile {
    pub path: PathBuf,
    pub manifest: Manifest,
}

fn open_archive(path: &Path) -> Result<ZipArchive<std::fs::File>, NightingaleError> {
    ZipArchive::new(std::fs::File::open(path)?).map_err(zip_err)
}

impl NgeFile {
    pub fn open(path: &Path) -> Result<Self, NightingaleError> {
        let mut archive = open_archive(path)?;
        let mut manifest_json = Vec::new();
        archive
            .by_name(MANIFEST_NAME)
            .map_err(zip_err)?
            .read_to_end(&mut manifest_json)?;
        let manifest: Manifest = serde_json::from_slice(&manifest_json)?;
        if manifest.version != FORMAT_VERSION {
            return Err(NightingaleError::Other(format!(
                "nge: unsupported manifest version {}",
                manifest.version
            )));
        }
        Ok(Self {
            path: path.to_path_buf(),
            manifest,
        })
    }

    pub fn read_entry(&self, name: &str) -> Result<Vec<u8>, NightingaleError> {
        let entry = self
            .manifest
            .entry(name)
            .ok_or_else(|| NightingaleError::Other(format!("nge: no entry named {name}")))?;

        let mut archive = open_archive(&self.path)?;
        let mut file = archive.by_name(name).map_err(zip_err)?;
        let mut bytes = Vec::with_capacity(entry.length as usize);
        file.read_to_end(&mut bytes)?;

        if short_blake3(&bytes) != entry.blake3 {
            return Err(NightingaleError::Other(format!(
                "nge: blake3 mismatch for {name}"
            )));
        }
        Ok(bytes)
    }
}
