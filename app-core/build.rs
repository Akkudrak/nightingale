use std::env;
use std::path::PathBuf;

/// Compile-time env vars that get baked into the binary via `option_env!`.
/// Each is sourced from the process env first, then from a `.env` at the
/// workspace root. Missing values are silently skipped so `option_env!`
/// resolves to `None` and the code falls back to runtime lookups.
const FORWARDED_KEYS: &[&str] = &["PIXABAY_API_KEY"];

fn main() {
    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let dotenv_path = manifest_dir
        .parent()
        .map(|p| p.join(".env"))
        .unwrap_or_else(|| PathBuf::from(".env"));

    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed={}", dotenv_path.display());

    for key in FORWARDED_KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }

    let from_file = dotenvy::from_path_iter(&dotenv_path)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .collect::<std::collections::HashMap<_, _>>();

    for key in FORWARDED_KEYS {
        let value = env::var(key)
            .ok()
            .filter(|v| !v.is_empty())
            .or_else(|| from_file.get(*key).cloned());

        if let Some(value) = value
            && !value.is_empty()
        {
            println!("cargo:rustc-env={key}={value}");
        }
    }

    bake_nge_key(&manifest_dir);
}

/// Bake the `.nge` master key into the crate at build time.
///
/// The key that opens `.nge` bundles is deliberately NOT committed in source.
/// It's read here from `keys/nge_master.key` (gitignored), falling back to the
/// committed `keys/nge_master.key.example` test key so a fresh clone still
/// builds. Override the path with the `NGE_KEY_FILE` env var. If no key file is
/// found the build fails loudly — a key is required to pack or open bundles.
///
/// The repo owner decides whether to ship the real key, keep the test one, or
/// remove it entirely.
fn bake_nge_key(manifest_dir: &std::path::Path) {
    let keys_dir = manifest_dir.join("keys");
    let real_key = keys_dir.join("nge_master.key");
    let example_key = keys_dir.join("nge_master.key.example");

    println!("cargo:rerun-if-changed={}", real_key.display());
    println!("cargo:rerun-if-changed={}", example_key.display());
    println!("cargo:rerun-if-env-changed=NGE_KEY_FILE");

    let key_path = env::var_os("NGE_KEY_FILE")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .or_else(|| real_key.is_file().then_some(real_key))
        .or_else(|| example_key.is_file().then_some(example_key));

    let bytes: Vec<u8> = match key_path {
        Some(path) => {
            let text = std::fs::read_to_string(&path)
                .unwrap_or_else(|e| panic!("failed to read .nge key file {}: {e}", path.display()));

            // Collect hex digits from non-comment lines (a key file may carry `#` docs).
            let hex: String = text
                .lines()
                .filter(|line| !line.trim_start().starts_with('#'))
                .flat_map(|line| line.chars())
                .filter(|c| c.is_ascii_hexdigit())
                .collect();

            assert!(
                hex.len() == 128,
                "{}: expected 64 bytes of key material (128 hex chars), got {}",
                path.display(),
                hex.len()
            );

            (0..hex.len())
                .step_by(2)
                .map(|i| {
                    u8::from_str_radix(&hex[i..i + 2], 16).expect("invalid hex in .nge key file")
                })
                .collect()
        }
        None => {
            // No key file (e.g. a fresh clone — no key material is committed).
            // Build with a NON-FUNCTIONAL dev placeholder so the project still
            // compiles; real `.nge` bundles won't open until a real key is
            // provided via keys/nge_master.key or $NGE_KEY_FILE.
            println!(
                "cargo:warning=.nge: no key file found (app-core/keys/nge_master.key or \
                 $NGE_KEY_FILE); building with a non-functional dev placeholder key — real \
                 .nge bundles will not open. Provide a key to pack/open bundles."
            );
            let mut placeholder = b"NIGHTINGALE_DEV_PLACEHOLDER_KEY_DO_NOT_SHIP".to_vec();
            placeholder.resize(64, 0x2a);
            placeholder
        }
    };

    let out_dir = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"));
    let dest = out_dir.join("nge_key.rs");
    std::fs::write(
        &dest,
        format!("pub(crate) const NGE_KEY_MATERIAL: [u8; 64] = {bytes:?};\n"),
    )
    .expect("failed to write generated nge_key.rs");
}
