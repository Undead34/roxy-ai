use anyhow::{Context, Result};
use tauri::{Manager, PhysicalPosition, PhysicalSize, WebviewWindow};
use thiserror::Error;
use window_vibrancy::apply_mica;

#[derive(Error, Debug)]
pub enum WindowSetupError {
    #[error("Failed to retrieve current monitor")]
    MonitorNotFound,
    #[error("Failed to set physical size: {0}")]
    SizeError(tauri::Error),
    #[error("Failed to set physical position: {0}")]
    PositionError(tauri::Error),
}

fn window_setup(window: &WebviewWindow) -> Result<()> {
    let Ok(Some(monitor)) = window.current_monitor() else {
        return Ok(());
    };

    let monitor_size = monitor.size();
    let target_width = (monitor_size.width as f64 * 0.70) as u32;
    let target_height = (monitor_size.height as f64 * 0.70) as u32;

    window
        .set_size(tauri::Size::Physical(PhysicalSize {
            width: target_width,
            height: target_height,
        }))
        .map_err(WindowSetupError::SizeError)?;

    let pos_x = (monitor_size.width as i32 - target_width as i32) / 2;
    let pos_y = (monitor_size.height as i32 - target_height as i32) / 2;

    window
        .set_position(tauri::Position::Physical(PhysicalPosition {
            x: pos_x,
            y: pos_y,
        }))
        .map_err(WindowSetupError::PositionError)?;

    Ok(())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let window = app
                .get_webview_window("main")
                .context("Missing 'main' window in config")?;

            window_setup(&window).context("Window setup routine failed")?;

            #[cfg(target_os = "windows")]
            if let Err(e) = apply_mica(&window, None) {
                eprintln!("Mica effect unsupported or failed: {}", e);
            }

            Ok(())
        })
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![greet])
        .run(tauri::generate_context!())
        .expect("Error while running Tauri application");
}
