#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("OPERATION_REPLAY: {}", .0.id)]
    Replay(Box<crate::state::Operation>),
    #[error("{0}")]
    Invalid(String),
    #[error("{0}")]
    Uncertain(String),
    #[error("UPGRADE_IN_PROGRESS: holder pid {0}")]
    Locked(u32),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Http(#[from] reqwest::Error),
}
pub type Result<T> = std::result::Result<T, Error>;
pub fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}
impl Error {
    pub fn is_uncertain(&self) -> bool {
        matches!(self, Self::Uncertain(_))
    }
}
