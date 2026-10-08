use std::sync::Arc;

use app_api::CommandState;

use crate::events::EventBus;
use crate::jukebox::JukeboxStore;

#[derive(Clone)]
pub(crate) struct AppState {
    pub commands: CommandState,
    pub events: Arc<EventBus>,
    pub jukebox: Arc<JukeboxStore>,
    pub data_path_pinned: bool,
    pub library_pinned: bool,
}

impl AppState {
    pub(crate) fn new(data_path_pinned: bool, library_pinned: bool) -> Self {
        let events = Arc::new(EventBus::new());

        Self {
            commands: CommandState::new(events.clone()),
            events,
            jukebox: Arc::new(JukeboxStore::new()),
            data_path_pinned,
            library_pinned,
        }
    }
}
