//! SingVerse's karaoke-room server API (`/api/nightingale/*`), every request
//! signed with HMAC-SHA256 over `timestamp.METHOD.path.body`, mirroring
//! `App\Support\NightingaleBridge::verify` on the Laravel side.

use std::time::Duration;

use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;

use super::auth::now;

#[derive(Clone)]
pub(crate) struct SingVerseClient {
    base: String,
    secret: Vec<u8>,
    agent: ureq::Agent,
}

/// What SingVerse answered, or why it could not be asked.
#[derive(Debug)]
pub(crate) enum ApiError {
    /// SingVerse refused the request (status and its message).
    Status(u16, String),
    /// Network or decoding trouble.
    Transport(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Status(status, message) => write!(f, "SingVerse answered {status}: {message}"),
            Self::Transport(message) => write!(f, "SingVerse unreachable: {message}"),
        }
    }
}

pub(crate) fn signature(
    secret: &[u8],
    timestamp: &str,
    method: &str,
    path: &str,
    body: &str,
) -> String {
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret) else {
        return String::new();
    };
    mac.update(format!("{timestamp}.{method}.{path}.{body}").as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

impl SingVerseClient {
    pub(crate) fn new(base: String, secret: Vec<u8>) -> Self {
        let agent = ureq::Agent::config_builder()
            .timeout_global(Some(Duration::from_secs(15)))
            .http_status_as_error(false)
            .build()
            .new_agent();
        Self {
            base,
            secret,
            agent,
        }
    }

    /// The room's state; `None` when it hasn't changed since `version`.
    pub(crate) fn room(&self, room: &str, version: Option<u64>) -> Result<Option<Value>, ApiError> {
        let path = format!("/api/nightingale/rooms/{room}");
        let query = version.map(|v| format!("?v={v}")).unwrap_or_default();
        let body = self.send("GET", &path, &query, None)?;
        if body.get("unchanged").and_then(Value::as_bool) == Some(true) {
            return Ok(None);
        }
        Ok(Some(body))
    }

    pub(crate) fn start(&self, room: &str, item: &str) -> Result<Value, ApiError> {
        let path = format!("/api/nightingale/rooms/{room}/items/{item}/start");
        self.send("POST", &path, "", Some(&serde_json::json!({})))
    }

    pub(crate) fn finish(
        &self,
        room: &str,
        item: &str,
        score: Option<u32>,
        skipped: bool,
    ) -> Result<Value, ApiError> {
        let path = format!("/api/nightingale/rooms/{room}/items/{item}/finish");
        self.send(
            "POST",
            &path,
            "",
            Some(&serde_json::json!({ "score": score, "skipped": skipped })),
        )
    }

    fn send(
        &self,
        method: &str,
        path: &str,
        query: &str,
        body: Option<&Value>,
    ) -> Result<Value, ApiError> {
        let content = body.map(Value::to_string).unwrap_or_default();
        let timestamp = now().to_string();
        let signed = signature(&self.secret, &timestamp, method, path, &content);
        let url = format!("{}{path}{query}", self.base);

        let response = if method == "GET" {
            self.agent
                .get(&url)
                .header("Accept", "application/json")
                .header("X-Nightingale-Timestamp", &timestamp)
                .header("X-Nightingale-Signature", &signed)
                .call()
        } else {
            self.agent
                .post(&url)
                .header("Accept", "application/json")
                .header("Content-Type", "application/json")
                .header("X-Nightingale-Timestamp", &timestamp)
                .header("X-Nightingale-Signature", &signed)
                .send(content.as_str())
        };

        let mut response = response.map_err(|e| ApiError::Transport(e.to_string()))?;
        let status = response.status().as_u16();
        let text = response
            .body_mut()
            .read_to_string()
            .map_err(|e| ApiError::Transport(e.to_string()))?;

        if !(200..300).contains(&status) {
            let message = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.get("message").and_then(Value::as_str).map(str::to_owned))
                .unwrap_or_else(|| text.chars().take(200).collect());
            return Err(ApiError::Status(status, message));
        }

        serde_json::from_str(&text).map_err(|e| ApiError::Transport(e.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Same vector as SingVerse's NightingaleBridge::sign:
    /// `php -r "echo hash_hmac('sha256','1700000000.GET./api/nightingale/rooms/abc.','secret');"`
    #[test]
    fn signs_like_the_laravel_side() {
        assert_eq!(
            signature(
                b"secret",
                "1700000000",
                "GET",
                "/api/nightingale/rooms/abc",
                ""
            ),
            "f3d6831847c8aa390a5f3878d048dc016155a275f0161d855f7e13b2cd0ce12b"
        );
    }
}
