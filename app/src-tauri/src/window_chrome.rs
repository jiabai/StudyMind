use serde::{Deserialize, Serialize};
use tauri::{PhysicalPosition, Window};

#[derive(Debug, Deserialize, Serialize)]
pub(crate) struct WindowPositionView {
    x: i32,
    y: i32,
}

#[tauri::command]
pub(crate) fn start_window_drag(window: Window) -> Result<(), String> {
    window.start_dragging().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn close_window(window: Window) -> Result<(), String> {
    window.close().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn minimize_window(window: Window) -> Result<(), String> {
    window.minimize().map_err(|error| error.to_string())
}

#[tauri::command]
pub(crate) fn toggle_maximize_window(window: Window) -> Result<(), String> {
    if window.is_maximized().map_err(|error| error.to_string())? {
        window.unmaximize().map_err(|error| error.to_string())
    } else {
        window.maximize().map_err(|error| error.to_string())
    }
}

#[tauri::command]
pub(crate) fn get_window_position(window: Window) -> Result<WindowPositionView, String> {
    let position = window.outer_position().map_err(|error| error.to_string())?;
    Ok(WindowPositionView {
        x: position.x,
        y: position.y,
    })
}

#[tauri::command]
pub(crate) fn set_window_position(
    window: Window,
    position: WindowPositionView,
) -> Result<(), String> {
    window
        .set_position(PhysicalPosition::new(position.x, position.y))
        .map_err(|error| error.to_string())
}
