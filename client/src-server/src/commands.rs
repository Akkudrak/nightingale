use app_api::CommandError;
use axum::{
    extract::{Path as AxumPath, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::Value;

use crate::state::AppState;

pub(crate) struct ApiError(CommandError);

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status =
            StatusCode::from_u16(self.0.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        (status, self.0.to_string()).into_response()
    }
}

pub(crate) async fn handle_cmd(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let payload = body.map(|Json(value)| value).unwrap_or(Value::Null);
    app_api::dispatch(state.commands.clone(), &name, payload)
        .await
        .map(Json)
        .map_err(ApiError)
}
