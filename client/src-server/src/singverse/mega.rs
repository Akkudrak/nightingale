//! Public MEGA file links (`mega.nz/file/{id}#{key}` and the legacy
//! `mega.nz/#!{id}!{key}`): ask MEGA's API for a temporary download URL, then
//! decrypt the stream with AES-128-CTR. Mirrors SingVerse's browser reader
//! (`resources/js/lib/nge/source.ts`).

use std::time::Duration;

use aes::cipher::{KeyIvInit, StreamCipher};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

// MEGA counts blocks in the low 64 bits after the 64-bit nonce, like the browser reader.
type Aes128Ctr = ctr::Ctr64BE<aes::Aes128>;

const API: &str = "https://g.api.mega.co.nz/cs";

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct MegaLink {
    pub(crate) id: String,
    key: [u8; 32],
}

fn valid_chars(value: &str) -> bool {
    value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub(crate) fn parse_link(url: &str) -> Option<MegaLink> {
    let url = url.trim();
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let rest = rest.strip_prefix("www.").unwrap_or(rest);
    let rest = rest
        .strip_prefix("mega.nz/")
        .or_else(|| rest.strip_prefix("mega.co.nz/"))?;

    let (id, key) = if let Some(file) = rest.strip_prefix("file/") {
        file.split_once('#')?
    } else {
        rest.strip_prefix("#!")?.split_once('!')?
    };
    // The key may be followed by a folder/file suffix in some shared links.
    let key = key.get(..43)?;
    if id.len() != 8 || !valid_chars(id) || !valid_chars(key) {
        return None;
    }

    let decoded = URL_SAFE_NO_PAD.decode(key).ok()?;
    let key: [u8; 32] = decoded.try_into().ok()?;
    Some(MegaLink {
        id: id.to_string(),
        key,
    })
}

impl MegaLink {
    /// A 256-bit file key: AES key = both halves XORed, nonce = bytes 16..24.
    pub(crate) fn decryptor(&self) -> Aes128Ctr {
        let mut aes_key = [0u8; 16];
        for (i, byte) in aes_key.iter_mut().enumerate() {
            *byte = self.key[i] ^ self.key[i + 16];
        }
        let mut iv = [0u8; 16];
        iv[..8].copy_from_slice(&self.key[16..24]);
        Aes128Ctr::new(&aes_key.into(), &iv.into())
    }

    /// Temporary download URL and size.
    pub(crate) fn download_url(&self) -> Result<(String, u64), String> {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(20)))
            .build()
            .new_agent();
        let body = serde_json::json!([{ "a": "g", "g": 1, "ssl": 1, "p": self.id }]);
        let id: u32 = rand_id();
        let value: serde_json::Value = agent
            .post(&format!("{API}?id={id}"))
            .header("Content-Type", "text/plain;charset=UTF-8")
            .send(body.to_string().as_str())
            .map_err(|e| format!("MEGA API: {e}"))?
            .body_mut()
            .read_json()
            .map_err(|e| format!("MEGA API: {e}"))?;

        let file = value.get(0).ok_or("MEGA: file unavailable")?;
        let url = file
            .get("g")
            .and_then(|g| g.as_str())
            .ok_or("MEGA: file unavailable (removed or over quota)")?;
        let size = file
            .get("s")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        Ok((url.to_string(), size))
    }
}

/// MEGA only wants a changing sequence number; it needs no randomness quality.
fn rand_id() -> u32 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(1)
}

/// Decrypts `data` in place, continuing the keystream across calls.
pub(crate) fn decrypt(cipher: &mut Aes128Ctr, data: &mut [u8]) {
    cipher.apply_keystream(data);
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINK: &str = "https://mega.nz/file/DuBWkD4B#AHHYF69DG5EdbE5b5SKs8G9BGrJuxuGF3iE4ctympNc";

    #[test]
    fn parses_both_link_styles() {
        let modern = parse_link(LINK).expect("modern link");
        assert_eq!(modern.id, "DuBWkD4B");
        let legacy =
            parse_link("https://mega.nz/#!DuBWkD4B!AHHYF69DG5EdbE5b5SKs8G9BGrJuxuGF3iE4ctympNc")
                .expect("legacy link");
        assert_eq!(modern, legacy);
        assert!(parse_link("https://example.com/file/DuBWkD4B#abc").is_none());
        assert!(parse_link("https://mega.nz/file/DuBWkD4B").is_none());
    }

    #[test]
    fn ctr_decryption_is_its_own_inverse_and_streams_across_chunks() {
        let link = parse_link(LINK).expect("link");
        let plain: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();

        let mut whole = plain.clone();
        decrypt(&mut link.decryptor(), &mut whole);
        assert_ne!(whole, plain);

        // Decrypting in uneven chunks with one cipher gives the same bytes.
        let mut chunked = whole.clone();
        let mut cipher = link.decryptor();
        let (a, b) = chunked.split_at_mut(333);
        decrypt(&mut cipher, a);
        decrypt(&mut cipher, b);
        assert_eq!(chunked, plain);
    }
}
