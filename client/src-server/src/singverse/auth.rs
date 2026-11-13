//! Who may use the screen: the room's host, sent here by SingVerse with a
//! short-lived HS256 JWT. The token is swapped for a signed session cookie
//! bound to that room, required by every API, media and WebSocket route.

use axum::{
    body::Body,
    extract::{Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;

use crate::state::AppState;

type HmacSha256 = Hmac<Sha256>;

pub(crate) const COOKIE: &str = "singverse_room";

/// A screen stays signed in for one long party; SingVerse closes idle rooms
/// after 12 hours anyway.
pub(crate) const SESSION_SECS: u64 = 16 * 3600;

#[derive(Debug, Deserialize)]
pub(crate) struct Claims {
    pub(crate) sub: String,
    #[serde(default)]
    pub(crate) name: String,
    pub(crate) room: String,
    pub(crate) exp: u64,
}

/// The room a request's session cookie unlocks.
#[derive(Clone, Debug)]
pub(crate) struct Session {
    pub(crate) room: String,
}

pub(crate) fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn mac(secret: &[u8]) -> Result<HmacSha256, String> {
    HmacSha256::new_from_slice(secret).map_err(|e| e.to_string())
}

/// Verifies SingVerse's entry token (HS256, unexpired) for `room`.
pub(crate) fn verify_jwt(secret: &[u8], token: &str, room: &str) -> Result<Claims, String> {
    let mut parts = token.split('.');
    let (Some(header), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err("malformed token".into());
    };

    let header_json = URL_SAFE_NO_PAD
        .decode(header)
        .map_err(|_| "malformed token header")?;
    let header_value: serde_json::Value =
        serde_json::from_slice(&header_json).map_err(|_| "malformed token header")?;
    if header_value.get("alg").and_then(|v| v.as_str()) != Some("HS256") {
        return Err("unsupported token algorithm".into());
    }

    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| "malformed token signature")?;
    // The signature covers the segments exactly as sent.
    let mut check = mac(secret)?;
    check.update(format!("{header}.{payload}").as_bytes());
    check
        .verify_slice(&signature)
        .map_err(|_| "invalid token signature")?;

    let claims: Claims = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| "malformed token payload")?,
    )
    .map_err(|_| "malformed token payload")?;

    if claims.exp < now() {
        return Err("expired token".into());
    }
    if claims.room != room {
        return Err("token is for another room".into());
    }
    Ok(claims)
}

/// `room.expires.signature`, all URL-safe.
pub(crate) fn session_cookie_value(
    secret: &[u8],
    room: &str,
    expires: u64,
) -> Result<String, String> {
    let body = format!("{room}.{expires}");
    let mut signer = mac(secret)?;
    signer.update(b"session:");
    signer.update(body.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(signer.finalize().into_bytes());
    Ok(format!("{body}.{signature}"))
}

pub(crate) fn verify_session_value(secret: &[u8], value: &str) -> Option<Session> {
    let mut parts = value.rsplitn(3, '.');
    let signature = parts.next()?;
    let expires = parts.next()?;
    let room = parts.next()?;
    let expires_at: u64 = expires.parse().ok()?;
    if expires_at < now() || !is_uuid(room) {
        return None;
    }

    let mut check = mac(secret).ok()?;
    check.update(b"session:");
    check.update(format!("{room}.{expires}").as_bytes());
    check
        .verify_slice(&URL_SAFE_NO_PAD.decode(signature).ok()?)
        .ok()?;

    Some(Session {
        room: room.to_string(),
    })
}

pub(crate) fn is_uuid(value: &str) -> bool {
    value.len() == 36
        && value.chars().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

pub(crate) fn session_from_headers(secret: &[u8], headers: &HeaderMap) -> Option<Session> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .filter(|(name, _)| *name == COOKIE)
        .find_map(|(_, value)| verify_session_value(secret, value))
}

pub(crate) fn set_cookie_header(value: &str, secure: bool) -> Option<HeaderValue> {
    let secure = if secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={SESSION_SECS}{secure}"
    ))
    .ok()
}

/// Every API, media and WebSocket request needs a valid room session.
pub(crate) async fn require_session(
    State(state): State<AppState>,
    mut request: Request<Body>,
    next: Next,
) -> Response {
    let Some(singverse) = state.singverse.as_ref() else {
        return next.run(request).await;
    };

    match session_from_headers(&singverse.config.secret, request.headers()) {
        Some(session) => {
            request.extensions_mut().insert(session);
            next.run(request).await
        }
        None => (
            StatusCode::UNAUTHORIZED,
            "open the screen from your SingVerse room",
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"test-secret-test-secret-test-secret-123";
    const ROOM: &str = "0b9c6f1e-2d3a-4b5c-8d7e-9f0a1b2c3d4e";

    fn jwt(claims: serde_json::Value, secret: &[u8]) -> String {
        let header = URL_SAFE_NO_PAD.encode(br#"{"alg":"HS256","typ":"JWT"}"#);
        let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
        let mut signer = mac(secret).expect("hmac");
        signer.update(format!("{header}.{payload}").as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(signer.finalize().into_bytes());
        format!("{header}.{payload}.{signature}")
    }

    #[test]
    fn accepts_a_valid_token_for_its_room_only() {
        let token = jwt(
            serde_json::json!({"sub": "u", "name": "Ana", "room": ROOM, "exp": now() + 60}),
            SECRET,
        );
        assert_eq!(verify_jwt(SECRET, &token, ROOM).expect("valid").name, "Ana");
        assert!(verify_jwt(SECRET, &token, "11111111-2222-3333-4444-555555555555").is_err());
        assert!(verify_jwt(b"another-secret-another-secret-another", &token, ROOM).is_err());
    }

    #[test]
    fn rejects_expired_and_tampered_tokens() {
        let expired = jwt(
            serde_json::json!({"sub": "u", "room": ROOM, "exp": 10}),
            SECRET,
        );
        assert!(verify_jwt(SECRET, &expired, ROOM).is_err());

        let token = jwt(
            serde_json::json!({"sub": "u", "room": ROOM, "exp": now() + 60}),
            SECRET,
        );
        let mut parts: Vec<&str> = token.split('.').collect();
        let forged = URL_SAFE_NO_PAD
            .encode(serde_json::json!({"sub": "x", "room": ROOM, "exp": now() + 9999}).to_string());
        parts[1] = &forged;
        assert!(verify_jwt(SECRET, &parts.join("."), ROOM).is_err());
    }

    #[test]
    fn session_cookies_round_trip_and_resist_tampering() {
        let value = session_cookie_value(SECRET, ROOM, now() + 60).expect("cookie");
        assert_eq!(
            verify_session_value(SECRET, &value).expect("session").room,
            ROOM
        );
        assert!(verify_session_value(
            SECRET,
            &value.replace(ROOM, "11111111-2222-3333-4444-555555555555")
        )
        .is_none());

        let expired = session_cookie_value(SECRET, ROOM, 10).expect("cookie");
        assert!(verify_session_value(SECRET, &expired).is_none());
    }
}
